import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import type { RequestListener } from "node:http";
import { Buffer } from "node:buffer";
import {
  type HeliusTransaction,
  kHeliusFetcher,
} from "../../../../src/plugins/app/listener/solana/helius-transaction-poller.js";
import { createTrackedServer } from "../../../helpers/http-server.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import {
  createEventBytes,
  toLogLine,
  createInMemoryEventsRepository,
} from "../../../helpers/solana-events.js";
import { waitFor } from "../../../helpers/wait-for.js";
import { build } from "../../../helpers/build.js";

function createTransaction(
  signature: string,
  slot: number,
  logMessages: string[] | null,
  err: unknown = null
): HeliusTransaction {
  return { signature, slot, meta: { err, logMessages } };
}

function heliusJsonHandler(data: HeliusTransaction[]): RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { data } }));
  };
}

async function createHeliusServer(
  t: TestContext,
  handler: RequestListener,
) {
  const server = createTrackedServer(handler);
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  t.after(() => server.close());
  return server.server.address() as AddressInfo;
}

describe("helius poller plugin", () => {
  async function buildApp(
    t: TestContext,
    heliusUrl: string,
    eventsRepo = createInMemoryEventsRepository(),
    opts: { enabled?: boolean } = {},
  ) {
    const app = await build(t, {
      useMocks: false,
      config: {
        HELIUS_POLLER_ENABLED: opts.enabled ?? true,
        HELIUS_RPC_URL: heliusUrl,
        HELIUS_POLLER_INTERVAL_MS: 10,
        HELIUS_POLLER_LOOKBACK_SECONDS: 60,
        HELIUS_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: eventsRepo,
      },
    });

    return { app, eventsRepo };
  }

  it("processes outbound event from Helius response", async (t: TestContext) => {
    const { port } = await createHeliusServer(t, heliusJsonHandler([
      createTransaction("sig-outbound", 500, [toLogLine(createEventBytes("outbound"))]),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    assert.strictEqual(eventsRepo.store[0].signature, "sig-outbound");
    assert.strictEqual(eventsRepo.store[0].slot, 500);
    assert.strictEqual(eventsRepo.store[0].type, "outbound");
  });

  it("processes outbound, override-outbound and inbound events", async (t: TestContext) => {
    const { port } = await createHeliusServer(t, heliusJsonHandler([
      createTransaction("sig-1", 100, [toLogLine(createEventBytes("outbound"))]),
      createTransaction("sig-2", 200, [toLogLine(createEventBytes("override"))]),
      createTransaction("sig-3", 300, [toLogLine(createEventBytes("inbound"))]),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 3);

    assert.strictEqual(eventsRepo.store.length, 3);
    assert.ok(eventsRepo.store.some((e) => e.type === "outbound" && e.signature === "sig-1"));
    assert.ok(eventsRepo.store.some((e) => e.type === "override-outbound" && e.signature === "sig-2"));
    assert.ok(eventsRepo.store.some((e) => e.type === "inbound" && e.signature === "sig-3"));
  });

  it("skips transactions with meta.err", async (t: TestContext) => {
    const { port } = await createHeliusServer(t, heliusJsonHandler([
      createTransaction("sig-err", 100, [toLogLine(createEventBytes("outbound"))], { err: "failed" }),
      createTransaction("sig-ok", 200, [toLogLine(createEventBytes("outbound"))]),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    assert.strictEqual(eventsRepo.store.length, 1);
    assert.strictEqual(eventsRepo.store[0].signature, "sig-ok");
  });

  it("skips signatures already in database", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    await eventsRepo.create({
      signature: "sig-existing",
      slot: 100,
      chain: "solana",
      type: "outbound",
      nonce: "nonce1",
      payload: { amount: "100", recipient: "r", sender: "s" },
    });

    const { port } = await createHeliusServer(t, heliusJsonHandler([
      createTransaction("sig-existing", 100, [toLogLine(createEventBytes("outbound"))]),
      createTransaction("sig-new", 200, [toLogLine(createEventBytes("outbound"))]),
    ]));

    await buildApp(t, `http://127.0.0.1:${port}`, eventsRepo);

    await waitFor(() => eventsRepo.store.length >= 2);

    assert.strictEqual(eventsRepo.store.length, 2);
    assert.strictEqual(eventsRepo.store[1].signature, "sig-new");
  });

  it("handles empty result.data gracefully", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createHeliusServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: {} }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => requestCount >= 2);

    assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("skips undecoded log entries", async (t: TestContext) => {
    const invalidLog = "Program data: " + Buffer.from(new Uint8Array([255, 1, 2])).toString("base64");
    const { port } = await createHeliusServer(t, heliusJsonHandler([
      createTransaction("sig-invalid", 100, [invalidLog, toLogLine(createEventBytes("outbound"))]),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    assert.strictEqual(eventsRepo.store.length, 1);
    assert.strictEqual(eventsRepo.store[0].signature, "sig-invalid");
  });

  it("does nothing when HELIUS_POLLER_ENABLED is false", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createHeliusServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { data: [] } }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`, undefined, { enabled: false });

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(requestCount, 0, "server should not receive any request when poller is disabled");
    assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("does not duplicate events across multiple poller rounds", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createHeliusServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        result: {
          data: [createTransaction("sig-stable", 100, [toLogLine(createEventBytes("outbound"))])],
        },
      }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => requestCount >= 3);

    const matchingEvents = eventsRepo.store.filter((e) => e.signature === "sig-stable");
    assert.strictEqual(matchingEvents.length, 1, "event should be stored exactly once despite multiple rounds");
  });

  it("survives a network error and processes the next round", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createHeliusServer(t, (req, res) => {
      requestCount++;
      if (requestCount === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        result: {
          data: [createTransaction("sig-after-error", 200, [toLogLine(createEventBytes("outbound"))])],
        },
      }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.some((e) => e.signature === "sig-after-error"));

    assert.ok(requestCount >= 2, "server should have received at least 2 requests");
  });

  it("survives an RPC error and processes the next round", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createHeliusServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      if (requestCount === 1) {
        res.end(JSON.stringify({ error: { message: "Rate limited" } }));
        return;
      }
      res.end(JSON.stringify({
        result: {
          data: [createTransaction("sig-after-rpc-error", 300, [toLogLine(createEventBytes("outbound"))])],
        },
      }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.some((e) => e.signature === "sig-after-rpc-error"));

    assert.ok(requestCount >= 2, "server should have received at least 2 requests");
  });

  it("uses custom fetcher when decorated", async (t: TestContext) => {
    const customTransactions = [
      createTransaction("custom-sig", 999, [toLogLine(createEventBytes("outbound"))]),
    ];

    const eventsRepo = createInMemoryEventsRepository();
    await build(t, {
      useMocks: false,
      config: {
        HELIUS_POLLER_ENABLED: true,
        HELIUS_RPC_URL: "http://unused",
        HELIUS_POLLER_INTERVAL_MS: 10,
        HELIUS_POLLER_LOOKBACK_SECONDS: 60,
        HELIUS_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: eventsRepo,
        [kHeliusFetcher]: async () => customTransactions,
      },
    });

    await waitFor(() => eventsRepo.store.length >= 1);

    assert.strictEqual(eventsRepo.store.length, 1);
    assert.strictEqual(eventsRepo.store[0].signature, "custom-sig");
  });
});
