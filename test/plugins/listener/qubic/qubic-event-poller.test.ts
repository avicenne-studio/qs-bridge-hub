import { describe, it, TestContext } from "node:test";
import { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import type { RequestListener } from "node:http";
import {
  type QubicEvent,
  kQubicEventFetcher,
} from "../../../../src/plugins/app/listener/qubic/qubic-event-poller.js";
import { createTrackedServer } from "../../../helpers/http-server.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import { createInMemoryEventsRepository } from "../../../helpers/solana-events.js";
import { waitFor } from "../../../helpers/wait-for.js";
import { build } from "../../../helpers/build.js";
import { mockLogMethod } from "../../../helpers/mocks/logger.js";

// ── helpers ───────────────────────────────────────────────────────────────────

// Mirrored from qubic-contract-client.ts (private constants)
const QSB_LOG_LOCK = 1;
const QSB_LOG_OVERRIDE_LOCK = 2;
const QSB_LOG_UNLOCK = 3;
const CONTRACT_INFO_LOG_TYPE = 6;
const QSB_CONTRACT_INDEX = 28;

/**
 * Build a lock/override-lock log content buffer (160B, header already stripped by Bob).
 *
 * Layout mirrors QSBLogLockMessage offset +8:
 *   [0..31]    fromAddress  [32..95]  toAddress (ASCII)
 *   [96..103]  amount       [104..111] relayerFee
 *   [112..115] networkOut   [116..119] nonce
 *   [120..151] orderHash    [152] success  [153] reasonCode  [154..155] pad
 *   [156..159] orderEra
 */
function buildLockLogContent(opts: {
  nonce: number;
  orderHash: Uint8Array;
  fromAddress?: Uint8Array;
  toAddress?: string;
  amount?: bigint;
  relayerFee?: bigint;
  networkOut?: number;
  success?: boolean;
  orderEra?: number;
}): string {
  const buf = Buffer.alloc(160);
  buf.set(opts.fromAddress ?? new Uint8Array(32), 0);
  buf.write(opts.toAddress ?? "SolAddr", 32, "ascii");
  buf.writeBigUInt64LE(opts.amount ?? 1000n, 96);
  buf.writeBigUInt64LE(opts.relayerFee ?? 10n, 104);
  buf.writeUInt32LE(opts.networkOut ?? 2, 112);
  buf.writeUInt32LE(opts.nonce, 116);
  buf.set(opts.orderHash, 120);
  buf.writeUInt8(opts.success !== false ? 1 : 0, 152);
  buf.writeUInt32LE(opts.orderEra ?? 0, 156);
  return buf.toString("hex");
}

/**
 * Build an unlock log content buffer (120B, header already stripped by Bob).
 *
 * Layout mirrors QSBLogUnlockMessage offset +8:
 *   [0..31]  orderHash   [32..63]  toAddress (Qubic addr)
 *   [64..71] amount      [72..79]  relayerFee
 *   [80..111] relayer    [112] success  [113] reasonCode  [114..115] pad
 *   [116..119] orderEra
 */
function buildUnlockLogContent(opts: {
  orderHash: Uint8Array;
  toAddress?: Uint8Array;
  amount?: bigint;
  relayerFee?: bigint;
  relayer?: Uint8Array;
  success?: boolean;
  orderEra?: number;
}): string {
  const buf = Buffer.alloc(120);
  buf.set(opts.orderHash, 0);
  buf.set(opts.toAddress ?? new Uint8Array(32), 32);
  buf.writeBigUInt64LE(opts.amount ?? 1000n, 64);
  buf.writeBigUInt64LE(opts.relayerFee ?? 10n, 72);
  buf.set(opts.relayer ?? new Uint8Array(32), 80);
  buf.writeUInt8(opts.success !== false ? 1 : 0, 112);
  buf.writeUInt32LE(opts.orderEra ?? 0, 116);
  return buf.toString("hex");
}

function buildBobEntry(logId: number, epoch: number, tick: number, scLogType: number, content: string) {
  return {
    ok: true,
    type: CONTRACT_INFO_LOG_TYPE,
    epoch,
    tick,
    logId,
    body: { scIndex: QSB_CONTRACT_INDEX, scLogType, content },
  };
}

/** Bob Node handler: /status returns the epoch; /log/... returns entries only for from=0. */
function makeBobHandler(entries: unknown[], epoch = 1): RequestListener {
  return (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/status") {
      res.end(JSON.stringify({ currentProcessingEpoch: epoch }));
      return;
    }
    const match = /^\/log\/\d+\/(\d+)\//.exec(req.url ?? "");
    const from = match ? parseInt(match[1], 10) : 1;
    res.end(JSON.stringify(from === 0 ? entries : []));
  };
}

async function createBobServer(t: TestContext, handler: RequestListener) {
  const server = createTrackedServer(handler);
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  t.after(() => server.close());
  return server.server.address() as AddressInfo;
}

const BASE_CONFIG = {
  QUBIC_POLLER_ENABLED: true,
  QUBIC_POLLER_INTERVAL_MS: 10,
  QUBIC_POLLER_TIMEOUT_MS: 1000,
  ORACLE_URLS: "",
};

async function buildApp(
  t: TestContext,
  bobUrl: string,
  eventsRepo = createInMemoryEventsRepository(),
  opts: {
    enabled?: boolean;
    decorators?: Record<PropertyKey, unknown>;
    config?: Partial<typeof BASE_CONFIG> & { QUBIC_BOB_URL?: string };
  } = {},
) {
  const app = await build(t, {
    useMocks: false,
    config: {
      ...BASE_CONFIG,
      ...opts.config,
      QUBIC_POLLER_ENABLED: opts.enabled ?? BASE_CONFIG.QUBIC_POLLER_ENABLED,
      QUBIC_BOB_URL: opts.config?.QUBIC_BOB_URL ?? bobUrl,
    },
    decorators: {
      [kEventsRepository]: eventsRepo,
      ...(opts.decorators ?? {}),
    },
  });

  return { app, eventsRepo };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("qubic poller plugin", () => {
  it("stores lock event decoded from Bob Node log", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xab);
    const content = buildLockLogContent({ nonce: 1, orderHash: hash });
    const entry = buildBobEntry(0, 1, 100, QSB_LOG_LOCK, content);
    const expectedSig = Buffer.from(hash).toString("hex");

    const { port } = await createBobServer(t, makeBobHandler([entry]));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, expectedSig);
    t.assert.strictEqual(eventsRepo.store[0].chain, "qubic");
    t.assert.strictEqual(eventsRepo.store[0].type, "lock");
    t.assert.strictEqual(eventsRepo.store[0].nonce, "1");
  });

  it("stores override-lock event from Bob Node log", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xac);
    const content = buildLockLogContent({ nonce: 2, orderHash: hash });
    const entry = buildBobEntry(0, 1, 101, QSB_LOG_OVERRIDE_LOCK, content);

    const { port } = await createBobServer(t, makeBobHandler([entry]));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].type, "override-lock");
    t.assert.strictEqual(eventsRepo.store[0].chain, "qubic");
  });

  it("skips events with success=false", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xcc);
    const content = buildLockLogContent({ nonce: 3, orderHash: hash, success: false });
    const entry = buildBobEntry(0, 1, 100, QSB_LOG_LOCK, content);

    const { port } = await createBobServer(t, makeBobHandler([entry]));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("does nothing when QUBIC_POLLER_ENABLED is false", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createBobServer(t, (req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/status" ? { currentProcessingEpoch: 1 } : []));
    });

    await buildApp(t, `http://127.0.0.1:${port}`, undefined, { enabled: false });

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(requestCount, 0);
  });

  it("does not duplicate lock events across multiple rounds", async (t: TestContext) => {
    let logRequestCount = 0;
    const hash = new Uint8Array(32).fill(0xdd);
    const content = buildLockLogContent({ nonce: 4, orderHash: hash });
    const entry = buildBobEntry(0, 1, 100, QSB_LOG_LOCK, content);
    const expectedSig = Buffer.from(hash).toString("hex");

    const { port } = await createBobServer(t, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/status") {
        res.end(JSON.stringify({ currentProcessingEpoch: 1 }));
        return;
      }
      logRequestCount++;
      const match = /^\/log\/\d+\/(\d+)\//.exec(req.url ?? "");
      const from = match ? parseInt(match[1], 10) : 1;
      res.end(JSON.stringify(from === 0 ? [entry] : []));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => logRequestCount >= 3);

    const matches = eventsRepo.store.filter((e) => e.signature === expectedSig);
    t.assert.strictEqual(matches.length, 1);
  });

  it("logs when fetcher throws and keeps running", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    const { app } = await buildApp(t, "http://unused", eventsRepo, {
      decorators: {
        [kQubicEventFetcher]: async () => {
          throw new Error("boom");
        },
      },
    });

    const warnMock = mockLogMethod(t, app.log, "warn");

    await waitFor(() =>
      warnMock.calls.some(
        (call: { arguments: unknown[] }) => call.arguments[1] === "qubic events poll failed",
      ),
    );

    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("uses custom fetcher when decorated", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    const hash = new Uint8Array(32).fill(0xee);
    const orderHash = Buffer.from(hash).toString("hex");
    const customEvent: QubicEvent = {
      chain: "qubic",
      type: "lock",
      nonce: "5",
      orderHash,
      payload: {
        fromAddress: "00".repeat(32),
        toAddress: "SolAddr",
        amount: "100",
        relayerFee: "1",
        nonce: "5",
        orderEra: "0",
      },
    };

    await buildApp(t, "http://unused", eventsRepo, {
      decorators: {
        [kQubicEventFetcher]: async () => [customEvent],
      },
    });

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, orderHash);
  });

  it("stores unlock event from Bob Node log", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xfa);
    const expectedSig = Buffer.from(hash).toString("hex");
    // Lock log populates orderHashToNonce map so unlock can recover the nonce.
    const lockContent = buildLockLogContent({ nonce: 10, orderHash: hash });
    const lockEntry = buildBobEntry(0, 1, 100, QSB_LOG_LOCK, lockContent);
    const unlockContent = buildUnlockLogContent({ orderHash: hash });
    const unlockEntry = buildBobEntry(1, 1, 101, QSB_LOG_UNLOCK, unlockContent);

    const { port } = await createBobServer(t, makeBobHandler([lockEntry, unlockEntry]));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.some((e) => e.type === "unlock"));

    const unlockEvent = eventsRepo.store.find((e) => e.type === "unlock")!;
    t.assert.strictEqual(unlockEvent.chain, "qubic");
    t.assert.strictEqual(unlockEvent.signature, expectedSig);
    t.assert.strictEqual(unlockEvent.nonce, "10");
  });

  it("stores unlock event with empty nonce when lock was not seen this session", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xfb);
    const expectedSig = Buffer.from(hash).toString("hex");
    const unlockContent = buildUnlockLogContent({ orderHash: hash });
    const unlockEntry = buildBobEntry(0, 1, 100, QSB_LOG_UNLOCK, unlockContent);

    const { port } = await createBobServer(t, makeBobHandler([unlockEntry]));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.some((e) => e.type === "unlock"));

    t.assert.strictEqual(eventsRepo.store[0].signature, expectedSig);
    t.assert.strictEqual(eventsRepo.store[0].nonce, "");
  });

  it("does not duplicate unlock events across multiple rounds", async (t: TestContext) => {
    let logRequestCount = 0;
    const hash = new Uint8Array(32).fill(0xfc);
    const lockContent = buildLockLogContent({ nonce: 11, orderHash: hash });
    const lockEntry = buildBobEntry(0, 1, 100, QSB_LOG_LOCK, lockContent);
    const unlockContent = buildUnlockLogContent({ orderHash: hash });
    const unlockEntry = buildBobEntry(1, 1, 101, QSB_LOG_UNLOCK, unlockContent);

    const { port } = await createBobServer(t, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/status") {
        res.end(JSON.stringify({ currentProcessingEpoch: 1 }));
        return;
      }
      logRequestCount++;
      const match = /^\/log\/\d+\/(\d+)\//.exec(req.url ?? "");
      const from = match ? parseInt(match[1], 10) : 2;
      res.end(JSON.stringify(from === 0 ? [lockEntry, unlockEntry] : []));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => logRequestCount >= 3);

    const unlockEvents = eventsRepo.store.filter((e) => e.type === "unlock");
    t.assert.strictEqual(unlockEvents.length, 1);
  });
});
