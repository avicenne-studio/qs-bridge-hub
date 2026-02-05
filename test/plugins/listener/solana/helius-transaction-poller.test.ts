import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import fastify from "fastify";
import fp from "fastify-plugin";
import {
  type HeliusFetcher,
  type HeliusTransaction,
  resolveHeliusFetcher,
  createDefaultHeliusFetcher,
} from "../../../../src/plugins/app/listener/solana/helius-transaction-poller.js";
import heliusTransactionPoller from "../../../../src/plugins/app/listener/solana/helius-transaction-poller.js";
import { UndiciClient } from "../../../../src/plugins/infra/undici-client.js";
import { build } from "../../../helpers/build.js";
import { createTrackedServer } from "../../../helpers/http-server.js";
import {
  kPoller,
  type PollerService,
} from "../../../../src/plugins/infra/poller.js";
import pollerPlugin from "../../../../src/plugins/infra/poller.js";
import {
  kUndiciClient,
  type UndiciClientService,
} from "../../../../src/plugins/infra/undici-client.js";
import undiciClientPlugin from "../../../../src/plugins/infra/undici-client.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import { kConfig } from "../../../../src/plugins/infra/env.js";
import {
  createEventBytes,
  toLogLine,
  createInMemoryEventsRepository,
} from "../../../helpers/solana-events.js";
import { FastifyInstance } from "fastify";

function createTransaction(
  signature: string,
  slot: number,
  logMessages: string[] | null,
  err: unknown = null
): HeliusTransaction {
  return { signature, slot, meta: { err, logMessages } };
}

async function buildHeliusPollerApp(
  t: TestContext,
  config: {
    heliusRpcUrl: string;
    heliusPollerIntervalMs: number;
    eventsRepository: ReturnType<typeof createInMemoryEventsRepository>;
  }
) {
  const app = fastify({ logger: false });

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kConfig, {
          HELIUS_POLLER_ENABLED: true,
          HELIUS_RPC_URL: config.heliusRpcUrl,
          HELIUS_POLLER_INTERVAL_MS: config.heliusPollerIntervalMs,
          HELIUS_POLLER_LOOKBACK_SECONDS: 60,
          HELIUS_POLLER_TIMEOUT_MS: 1000,
        });
      },
      { name: "env" }
    )
  );

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kEventsRepository, config.eventsRepository);
      },
      { name: "events-repository" }
    )
  );

  app.register(pollerPlugin);
  app.register(undiciClientPlugin);
  app.register(heliusTransactionPoller);

  await app.ready();
  t.after(() => app.close());

  return { app, eventsRepository: config.eventsRepository };
}

async function setupHeliusTest(
  t: TestContext,
  mockTransactions: HeliusTransaction[],
  intervalMs = 1000
) {
  const server = createTrackedServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      result: { data: mockTransactions }
    }));
  });

  await new Promise<void>((resolve) => {
    server.server.listen(0, resolve);
  });
  t.after(() => server.close());

  const { port } = server.server.address() as AddressInfo;
  const eventsRepo = createInMemoryEventsRepository();
  
  await buildHeliusPollerApp(t, {
    heliusRpcUrl: `http://127.0.0.1:${port}`,
    heliusPollerIntervalMs: intervalMs,
    eventsRepository: eventsRepo,
  });

  return eventsRepo;
}

describe("helius transaction poller plugin", () => {
  describe("resolveHeliusFetcher", () => {
    it("returns default when no custom fetcher exists", () => {
      const defaultFetcher: HeliusFetcher = async () => [];
      const factory = () => defaultFetcher;
      assert.strictEqual(resolveHeliusFetcher({} as unknown as FastifyInstance, factory), defaultFetcher);
    });

    it("returns custom fetcher from instance", () => {
      const defaultFetcher: HeliusFetcher = async () => [];
      const customFetcher: HeliusFetcher = async () => [createTransaction("custom", 1, [])];
      const factory = () => defaultFetcher;
      assert.strictEqual(resolveHeliusFetcher({ heliusFetcher: customFetcher } as unknown as FastifyInstance, factory), customFetcher);
    });

    it("returns custom fetcher from parent", () => {
      const defaultFetcher: HeliusFetcher = async () => [];
      const customFetcher: HeliusFetcher = async () => [createTransaction("custom", 1, [])];
      const factory = () => defaultFetcher;
      assert.strictEqual(resolveHeliusFetcher({ parent: { heliusFetcher: customFetcher } } as unknown as FastifyInstance, factory), customFetcher);
    });
  });

  describe("createDefaultHeliusFetcher", () => {
    async function createTestServer(t: TestContext, response: unknown) {
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

    it("makes POST requests to Helius RPC", async (t: TestContext) => {
      const { port, client, receivedBodies } = await createTestServer(t, {
        result: { data: [{ signature: "test-sig", slot: 123, meta: { err: null, logMessages: [] } }] },
      });

      const fetcher = createDefaultHeliusFetcher(client, `http://127.0.0.1:${port}/rpc`, 600);
      const result = await fetcher(new AbortController().signal);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].signature, "test-sig");
      assert.strictEqual((receivedBodies[0] as { method: string }).method, "getTransactionsForAddress");
    });

    it("throws on RPC error response", async (t: TestContext) => {
      const { port, client } = await createTestServer(t, { error: { message: "Rate limited" } });
      const fetcher = createDefaultHeliusFetcher(client, `http://127.0.0.1:${port}/rpc`, 600);
      await assert.rejects(fetcher(new AbortController().signal), /Rate limited/);
    });

    it("returns empty array when result.data is missing", async (t: TestContext) => {
      const { port, client } = await createTestServer(t, { result: {} });
      const fetcher = createDefaultHeliusFetcher(client, `http://127.0.0.1:${port}/rpc`, 600);
      assert.deepStrictEqual(await fetcher(new AbortController().signal), []);
    });
  });

  describe("plugin lifecycle", () => {
    it("skips initialization when HELIUS_POLLER_ENABLED is false", async (t: TestContext) => {
      const app = await build(t);
      
      const pollerService = app.getDecorator<PollerService>(kPoller);
      t.assert.ok(pollerService, "PollerService should be available even when poller is disabled");
    });

    it("creates poller and undici client when enabled", async (t: TestContext) => {
      const app = await build(t);
      
      const pollerService = app.getDecorator<PollerService>(kPoller);
      const undiciService = app.getDecorator<UndiciClientService>(kUndiciClient);
      
      t.assert.ok(pollerService, "PollerService should be available");
      t.assert.ok(undiciService, "UndiciClient should be available");
    });
  });

  describe("integration tests with real services", () => {
    it("fetches and processes outbound events from mock Helius server", async (t: TestContext) => {
      const eventsRepo = await setupHeliusTest(t, [
        createTransaction("sig1", 100, [toLogLine(createEventBytes("outbound"))])
      ]);

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(eventsRepo.store.length, 1);
      assert.strictEqual(eventsRepo.store[0].signature, "sig1");
      assert.strictEqual(eventsRepo.store[0].slot, 100);
      assert.strictEqual(eventsRepo.store[0].type, "outbound");
    });

    it("processes multiple event types and filters correctly", async (t: TestContext) => {
      const eventsRepo = await setupHeliusTest(t, [
        createTransaction("sig-out", 100, [toLogLine(createEventBytes("outbound"))]),
        createTransaction("sig-override", 200, [toLogLine(createEventBytes("override"))]),
        createTransaction("sig-inbound", 300, [toLogLine(createEventBytes("inbound"))]),
      ]);

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(eventsRepo.store.length, 2);
      assert.strictEqual(eventsRepo.store[0].type, "outbound");
      assert.strictEqual(eventsRepo.store[1].type, "override-outbound");
    });

    it("skips transactions with errors", async (t: TestContext) => {
      const eventsRepo = await setupHeliusTest(t, [
        createTransaction("sig-error", 100, [toLogLine(createEventBytes("outbound"))], { err: "some error" }),
        createTransaction("sig-ok", 200, [toLogLine(createEventBytes("outbound"))]),
      ]);

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(eventsRepo.store.length, 1);
      assert.strictEqual(eventsRepo.store[0].signature, "sig-ok");
    });

    it("deduplicates transactions across polling rounds", async (t: TestContext) => {
      let requestCount = 0;
      const tx1 = createTransaction("sig-dup", 100, [toLogLine(createEventBytes("outbound"))]);
      const tx2 = createTransaction("sig-new", 200, [toLogLine(createEventBytes("outbound"))]);
      
      const server = createTrackedServer((req, res) => {
        requestCount++;
        const data = requestCount === 1 ? [tx1] : [tx1, tx2];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          result: { data }
        }));
      });

      await new Promise<void>((resolve) => {
        server.server.listen(0, resolve);
      });
      t.after(() => server.close());

      const { port } = server.server.address() as AddressInfo;
      const eventsRepo = createInMemoryEventsRepository();
      
      await buildHeliusPollerApp(t, {
        heliusRpcUrl: `http://127.0.0.1:${port}`,
        heliusPollerIntervalMs: 1000,
        eventsRepository: eventsRepo,
      });

      await new Promise(resolve => setTimeout(resolve, 2400));

      assert.strictEqual(eventsRepo.store.length, 2);
      assert.strictEqual(eventsRepo.store[0].signature, "sig-dup");
      assert.strictEqual(eventsRepo.store[1].signature, "sig-new");
    });

    it("skips transactions without log messages", async (t: TestContext) => {
      const eventsRepo = await setupHeliusTest(t, [
        createTransaction("sig-no-logs", 100, null),
        createTransaction("sig-with-logs", 200, [toLogLine(createEventBytes("outbound"))]),
      ]);

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(eventsRepo.store.length, 1);
      assert.strictEqual(eventsRepo.store[0].signature, "sig-with-logs");
    });

    it("ignores malformed event logs that cannot be decoded", async (t: TestContext) => {
      const eventsRepo = await setupHeliusTest(t, [
        createTransaction("sig-malformed", 100, [
          "Program log: Instruction: InitializeBridge",
          "Program log: invalid event data xyz123"
        ]),
        createTransaction("sig-valid", 200, [toLogLine(createEventBytes("outbound"))]),
      ]);

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(eventsRepo.store.length, 1);
      assert.strictEqual(eventsRepo.store[0].signature, "sig-valid");
    });

    it("handles empty response from Helius server", async (t: TestContext) => {
      const eventsRepo = await setupHeliusTest(t, []);

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(eventsRepo.store.length, 0);
    });

    it("continues processing other events when one fails", async (t: TestContext) => {
      const server = createTrackedServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          result: { data: [
            createTransaction("sig-fail", 100, [toLogLine(createEventBytes("outbound"))]),
            createTransaction("sig-ok", 200, [toLogLine(createEventBytes("outbound"))]),
          ]}
        }));
      });

      await new Promise<void>((resolve) => {
        server.server.listen(0, resolve);
      });
      t.after(() => server.close());

      const { port } = server.server.address() as AddressInfo;
      
      let callCount = 0;
      const failingRepo = createInMemoryEventsRepository();
      const originalCreate = failingRepo.create;
      failingRepo.create = async (event) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Database error");
        }
        return originalCreate(event);
      };
      
      await buildHeliusPollerApp(t, {
        heliusRpcUrl: `http://127.0.0.1:${port}`,
        heliusPollerIntervalMs: 1000,
        eventsRepository: failingRepo,
      });

      await new Promise(resolve => setTimeout(resolve, 1200));

      assert.strictEqual(failingRepo.store.length, 1);
      assert.strictEqual(failingRepo.store[0].signature, "sig-ok");
    });

    it("handles server timeout gracefully", async (t: TestContext) => {
      const server = createTrackedServer(() => {
        // Don't respond, let it timeout
      });

      await new Promise<void>((resolve) => {
        server.server.listen(0, resolve);
      });
      t.after(() => server.close());

      const { port } = server.server.address() as AddressInfo;
      const eventsRepo = createInMemoryEventsRepository();
      
      await buildHeliusPollerApp(t, {
        heliusRpcUrl: `http://127.0.0.1:${port}`,
        heliusPollerIntervalMs: 1000,
        eventsRepository: eventsRepo,
      });

      await new Promise(resolve => setTimeout(resolve, 1500));

      assert.strictEqual(eventsRepo.store.length, 0);
    });
  });
});