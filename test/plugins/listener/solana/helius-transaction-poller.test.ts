import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import fastify from "fastify";
import fp from "fastify-plugin";
import {
  type HeliusTransaction,
  createDefaultHeliusFetcher,
  kHeliusFetcher,
} from "../../../../src/plugins/app/listener/solana/helius-transaction-poller.js";
import heliusTransactionPoller from "../../../../src/plugins/app/listener/solana/helius-transaction-poller.js";
import { UndiciClient } from "../../../../src/plugins/infra/undici-client.js";
import { createTrackedServer } from "../../../helpers/http-server.js";
import pollerPlugin from "../../../../src/plugins/infra/poller.js";
import undiciClientPlugin from "../../../../src/plugins/infra/undici-client.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import { kConfig } from "../../../../src/plugins/infra/env.js";
import {
  createEventBytes,
  toLogLine,
  createInMemoryEventsRepository,
} from "../../../helpers/solana-events.js";

function createTransaction(
  signature: string,
  slot: number,
  logMessages: string[] | null,
  err: unknown = null
): HeliusTransaction {
  return { signature, slot, meta: { err, logMessages } };
}

describe("createDefaultHeliusFetcher", () => {
  async function createMockHelius(t: TestContext, response: unknown) {
    const receivedBodies: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    t.after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const client = new UndiciClient();
    t.after(() => client.close());
    return { port, client, receivedBodies };
  }

  it("calls getTransactionsForAddress and returns result", async (t: TestContext) => {
    const { port, client, receivedBodies } = await createMockHelius(t, {
      result: { data: [{ signature: "sig1", slot: 100, meta: { err: null, logMessages: [] } }] },
    });

    const fetcher = createDefaultHeliusFetcher(client, `http://127.0.0.1:${port}`, 600);
    const result = await fetcher(new AbortController().signal);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].signature, "sig1");
    assert.strictEqual((receivedBodies[0] as { method: string }).method, "getTransactionsForAddress");
  });

  it("throws on RPC error response", async (t: TestContext) => {
    const { port, client } = await createMockHelius(t, { error: { message: "Rate limited" } });
    const fetcher = createDefaultHeliusFetcher(client, `http://127.0.0.1:${port}`, 600);

    await assert.rejects(fetcher(new AbortController().signal), /Rate limited/);
  });

  it("returns empty array when result.data is missing", async (t: TestContext) => {
    const { port, client } = await createMockHelius(t, { result: {} });
    const fetcher = createDefaultHeliusFetcher(client, `http://127.0.0.1:${port}`, 600);

    assert.deepStrictEqual(await fetcher(new AbortController().signal), []);
  });
});

describe("helius poller plugin", () => {
  async function createMockHeliusServer(t: TestContext, getTransactions: () => HeliusTransaction[]) {
    const server = createTrackedServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { data: getTransactions() } }));
    });
    await new Promise<void>((resolve) => server.server.listen(0, resolve));
    t.after(() => server.close());
    return server.server.address() as AddressInfo;
  }

  async function buildApp(t: TestContext, heliusUrl: string, eventsRepo = createInMemoryEventsRepository()) {
    const app = fastify({ logger: false });

    app.register(fp(async (instance) => {
      instance.decorate(kConfig, {
        HELIUS_POLLER_ENABLED: true,
        HELIUS_RPC_URL: heliusUrl,
        HELIUS_POLLER_INTERVAL_MS: 100,
        HELIUS_POLLER_LOOKBACK_SECONDS: 60,
        HELIUS_POLLER_TIMEOUT_MS: 1000,
      });
    }, { name: "env" }));

    app.register(fp(async (instance) => {
      instance.decorate(kEventsRepository, eventsRepo);
    }, { name: "events-repository" }));

    app.register(pollerPlugin);
    app.register(undiciClientPlugin);
    app.register(heliusTransactionPoller);

    await app.ready();
    t.after(() => app.close());

    return { app, eventsRepo };
  }

  it("processes outbound event from Helius response", async (t: TestContext) => {
    const { port } = await createMockHeliusServer(t, () => [
      createTransaction("sig-outbound", 500, [toLogLine(createEventBytes("outbound"))]),
    ]);

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(eventsRepo.store.length, 1);
    assert.strictEqual(eventsRepo.store[0].signature, "sig-outbound");
    assert.strictEqual(eventsRepo.store[0].slot, 500);
    assert.strictEqual(eventsRepo.store[0].type, "outbound");
  });

  it("filters out inbound events, keeps outbound and override-outbound", async (t: TestContext) => {
    const { port } = await createMockHeliusServer(t, () => [
      createTransaction("sig-1", 100, [toLogLine(createEventBytes("outbound"))]),
      createTransaction("sig-2", 200, [toLogLine(createEventBytes("override"))]),
      createTransaction("sig-3", 300, [toLogLine(createEventBytes("inbound"))]),
    ]);

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(eventsRepo.store.length, 2);
    assert.ok(eventsRepo.store.some((e) => e.type === "outbound"));
    assert.ok(eventsRepo.store.some((e) => e.type === "override-outbound"));
  });

  it("skips transactions with meta.err", async (t: TestContext) => {
    const { port } = await createMockHeliusServer(t, () => [
      createTransaction("sig-err", 100, [toLogLine(createEventBytes("outbound"))], { err: "failed" }),
      createTransaction("sig-ok", 200, [toLogLine(createEventBytes("outbound"))]),
    ]);

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 200));

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

    const { port } = await createMockHeliusServer(t, () => [
      createTransaction("sig-existing", 100, [toLogLine(createEventBytes("outbound"))]),
      createTransaction("sig-new", 200, [toLogLine(createEventBytes("outbound"))]),
    ]);

    await buildApp(t, `http://127.0.0.1:${port}`, eventsRepo);
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(eventsRepo.store.length, 2);
    assert.strictEqual(eventsRepo.store[1].signature, "sig-new");
  });

  it("uses custom fetcher when decorated", async (t: TestContext) => {
    const customTransactions = [
      createTransaction("custom-sig", 999, [toLogLine(createEventBytes("outbound"))]),
    ];

    const app = fastify({ logger: false });

    app.register(fp(async (instance) => {
      instance.decorate(kConfig, {
        HELIUS_POLLER_ENABLED: true,
        HELIUS_RPC_URL: "http://unused",
        HELIUS_POLLER_INTERVAL_MS: 100,
        HELIUS_POLLER_LOOKBACK_SECONDS: 60,
        HELIUS_POLLER_TIMEOUT_MS: 1000,
      });
    }, { name: "env" }));

    const eventsRepo = createInMemoryEventsRepository();
    app.register(fp(async (instance) => {
      instance.decorate(kEventsRepository, eventsRepo);
    }, { name: "events-repository" }));

    app.decorate(kHeliusFetcher, async () => customTransactions);

    app.register(pollerPlugin);
    app.register(undiciClientPlugin);
    app.register(heliusTransactionPoller);

    await app.ready();
    t.after(() => app.close());

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(eventsRepo.store.length, 1);
    assert.strictEqual(eventsRepo.store[0].signature, "custom-sig");
  });
});
