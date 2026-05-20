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

/** Build a LockedOrderEntry (168 bytes) at a buffer offset. */
function writeLockedOrderEntry(
  buf: Buffer,
  offset: number,
  opts: { nonce: number; orderHash: Uint8Array; active?: boolean },
) {
  // sender (32B) — leave as zeros
  // amount (8B)
  buf.writeBigUInt64LE(1000n, offset + 32);
  // relayerFee (8B)
  buf.writeBigUInt64LE(10n, offset + 40);
  // networkOut (4B)
  buf.writeUInt32LE(2, offset + 48);
  // nonce (4B)
  buf.writeUInt32LE(opts.nonce, offset + 52);
  // toAddress (64B ASCII)
  buf.write("SolAddr", offset + 56, "ascii");
  // orderHash (32B)
  buf.set(opts.orderHash, offset + 120);
  // lockEpoch (4B)
  buf.writeUInt32LE(1, offset + 152);
  // orderEra (4B)
  buf.writeUInt32LE(0, offset + 156);
  // active (1B)
  buf.writeUInt8(opts.active !== false ? 1 : 0, offset + 160);
}

/** Build a hex-encoded GetLockedOrders_output with a single active entry. */
function buildGetLockedOrdersHex(
  entries: Array<{ nonce: number; orderHash: Uint8Array; active?: boolean }>,
): string {
  const buf = Buffer.alloc(8 + 64 * 168);
  buf.writeUInt32LE(entries.length, 0); // totalActive
  buf.writeUInt32LE(entries.length, 4); // returned
  for (let i = 0; i < entries.length; i++) {
    writeLockedOrderEntry(buf, 8 + i * 168, entries[i]);
  }
  return buf.toString("hex");
}

/** HTTP handler that returns a GetLockedOrders contract response. */
function contractJsonHandler(responseHex: string): RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: responseHex }));
  };
}

async function createContractServer(t: TestContext, handler: RequestListener) {
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
  rpcUrl: string,
  eventsRepo = createInMemoryEventsRepository(),
  opts: {
    enabled?: boolean;
    decorators?: Record<PropertyKey, unknown>;
    config?: Partial<typeof BASE_CONFIG> & { QUBIC_RPC_URL?: string };
  } = {},
) {
  const app = await build(t, {
    useMocks: false,
    config: {
      ...BASE_CONFIG,
      ...opts.config,
      QUBIC_POLLER_ENABLED: opts.enabled ?? BASE_CONFIG.QUBIC_POLLER_ENABLED,
      QUBIC_RPC_URL: opts.config?.QUBIC_RPC_URL ?? rpcUrl,
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
  it("stores lock events decoded from GetLockedOrders", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xab);
    const responseHex = buildGetLockedOrdersHex([{ nonce: 1, orderHash: hash }]);
    const expectedSig = Buffer.from(hash).toString("hex");

    const { port } = await createContractServer(t, contractJsonHandler(responseHex));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, expectedSig);
    t.assert.strictEqual(eventsRepo.store[0].chain, "qubic");
    t.assert.strictEqual(eventsRepo.store[0].type, "lock");
  });

  it("skips inactive entries", async (t: TestContext) => {
    const hash = new Uint8Array(32).fill(0xcc);
    const responseHex = buildGetLockedOrdersHex([{ nonce: 2, orderHash: hash, active: false }]);

    const { port } = await createContractServer(t, contractJsonHandler(responseHex));
    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("does nothing when QUBIC_POLLER_ENABLED is false", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createContractServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: buildGetLockedOrdersHex([]) }));
    });

    await buildApp(t, `http://127.0.0.1:${port}`, undefined, { enabled: false });

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(requestCount, 0);
  });

  it("does not duplicate events across multiple rounds", async (t: TestContext) => {
    let requestCount = 0;
    const hash = new Uint8Array(32).fill(0xdd);
    const responseHex = buildGetLockedOrdersHex([{ nonce: 3, orderHash: hash }]);
    const expectedSig = Buffer.from(hash).toString("hex");

    const { port } = await createContractServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: responseHex }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => requestCount >= 3);

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
        (call) => call.arguments[1] === "qubic events poll failed",
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
});
