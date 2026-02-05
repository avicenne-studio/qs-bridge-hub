import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import heliusTransactionPoller, {
  type HeliusFetcher,
  type HeliusTransaction,
  resolveHeliusFetcher,
  createDefaultHeliusFetcher,
} from "../../../../src/plugins/app/listener/solana/helius-transaction-poller.ts";
import { UndiciClient } from "../../../../src/plugins/infra/undici-client.js";
import { kConfig } from "../../../../src/plugins/infra/env.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import { kPoller } from "../../../../src/plugins/infra/poller.js";
import { kUndiciClient } from "../../../../src/plugins/infra/undici-client.js";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";
import { getInboundEventEncoder } from "../../../../src/clients/js/types/inboundEvent.js";
import { LOG_PREFIX } from "../../../../src/plugins/app/listener/solana/solana-program-logs.js";

const NONCE = (n: number) => { const arr = new Uint8Array(32); arr[31] = n; return arr; };
const BYTES32 = (fill: number) => new Uint8Array(32).fill(fill);

const BASE_EVENT_DATA = {
  networkIn: 1,
  networkOut: 2,
  tokenIn: BYTES32(1),
  tokenOut: BYTES32(2),
  fromAddress: BYTES32(3),
  toAddress: BYTES32(4),
  amount: 10n,
  relayerFee: 2n,
};

function createEventBytes(type: "outbound" | "override" | "inbound"): Uint8Array {
  if (type === "outbound") {
    return new Uint8Array(getOutboundEventEncoder().encode({
      discriminator: 1, ...BASE_EVENT_DATA, networkOut: 1, nonce: NONCE(1),
    }));
  }
  if (type === "override") {
    return new Uint8Array(getOverrideOutboundEventEncoder().encode({
      discriminator: 2, toAddress: BYTES32(9), relayerFee: 7n, nonce: NONCE(2),
    }));
  }
  return new Uint8Array(getInboundEventEncoder().encode({
    discriminator: 0, ...BASE_EVENT_DATA, nonce: NONCE(3),
  }));
}

const toLogLine = (bytes: Uint8Array) => LOG_PREFIX + Buffer.from(bytes).toString("base64");

function createTransaction(
  signature: string,
  slot: number,
  logMessages: string[] | null,
  err: unknown = null
): HeliusTransaction {
  return { signature, slot, meta: { err, logMessages } };
}

type StoredEvent = {
  id: number;
  signature: string;
  slot: number | null;
  chain: "solana";
  type: "outbound" | "override-outbound";
  nonce: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

function createInMemoryEvents() {
  const store: StoredEvent[] = [];
  let nextId = 1;
  return {
    store,
    async create(event: Omit<StoredEvent, "id" | "createdAt">) {
      const created = { id: nextId++, createdAt: new Date().toISOString(), ...event };
      store.push(created);
      return created;
    },
    async listAfter(afterId: number, limit: number) {
      return store.filter((e) => e.id > afterId).slice(0, limit);
    },
  };
}

type MockPoller = {
  started: boolean;
  stopped: boolean;
  onRound: (responses: unknown[]) => Promise<void> | void;
  fetchOne: (server: string, signal: AbortSignal) => Promise<unknown>;
};

function createMockPollerService() {
  const pollers: MockPoller[] = [];
  return {
    pollers,
    defaults: { intervalMs: 50, requestTimeoutMs: 1000, jitterMs: 0 },
    create<T>(config: {
      servers: string[];
      fetchOne: (server: string, signal: AbortSignal) => Promise<T>;
      onRound: (responses: T[]) => Promise<void> | void;
      intervalMs: number;
      requestTimeoutMs: number;
      jitterMs: number;
    }) {
      const poller: MockPoller = {
        started: false,
        stopped: false,
        onRound: config.onRound as MockPoller["onRound"],
        fetchOne: config.fetchOne as MockPoller["fetchOne"],
      };
      pollers.push(poller);
      return {
        start() { poller.started = true; },
        async stop() { poller.stopped = true; },
        isRunning() { return poller.started && !poller.stopped; },
      };
    },
  };
}

const createMockUndiciService = () => ({
  defaults: {},
  create: () => ({ getJson: async () => ({}), postJson: async () => ({}), close: async () => {} }),
});

const BASE_CONFIG = {
  HELIUS_RPC_URL: "http://localhost:8899",
  HELIUS_POLLER_INTERVAL_MS: 50,
  HELIUS_POLLER_LOOKBACK_SECONDS: 60,
  HELIUS_POLLER_TIMEOUT_MS: 1000,
  PORT: 3000,
  HOST: "127.0.0.1",
  RATE_LIMIT_MAX: 100,
  SQLITE_DB_FILE: ":memory:",
  ORACLE_URLS: "http://localhost:3001",
  ORACLE_SIGNATURE_THRESHOLD: 2,
  HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
};

type PollerAppOptions = {
  enabled?: boolean;
  heliusFetcher?: HeliusFetcher;
  eventsRepository?: ReturnType<typeof createInMemoryEvents>;
  pollerService?: ReturnType<typeof createMockPollerService>;
};

async function buildPollerApp(opts: PollerAppOptions = {}) {
  const {
    enabled = true,
    heliusFetcher,
    eventsRepository = createInMemoryEvents(),
    pollerService = createMockPollerService(),
  } = opts;

  const app = fastify({ logger: false });

  app.register(fp(async (i) => { i.decorate(kConfig, { ...BASE_CONFIG, HELIUS_POLLER_ENABLED: enabled }); }, { name: "env" }));
  app.register(fp(async (i) => { i.decorate(kEventsRepository, eventsRepository); }, { name: "events-repository" }));
  app.register(fp(async (i) => { i.decorate(kPoller, pollerService); }, { name: "polling" }));
  app.register(fp(async (i) => { i.decorate(kUndiciClient, createMockUndiciService()); }, { name: "undici-client" }));

  if (heliusFetcher) app.decorate("heliusFetcher", heliusFetcher);

  app.register(heliusTransactionPoller);
  await app.ready();

  return { app, eventsRepository, pollerService };
}

async function setupAndRun(
  t: TestContext,
  transactions: HeliusTransaction[],
  eventsRepository = createInMemoryEvents()
) {
  const pollerService = createMockPollerService();
  const { app } = await buildPollerApp({
    heliusFetcher: async () => transactions,
    eventsRepository,
    pollerService,
  });
  t.after(() => app.close());
  await pollerService.pollers[0].onRound([transactions]);
  return eventsRepository.store;
}

describe("helius transaction poller plugin", () => {
  describe("resolveHeliusFetcher", () => {
    it("returns default when no custom fetcher exists", () => {
      const defaultFetcher: HeliusFetcher = async () => [];
      assert.strictEqual(resolveHeliusFetcher({}, defaultFetcher), defaultFetcher);
    });

    it("returns custom fetcher from instance", () => {
      const defaultFetcher: HeliusFetcher = async () => [];
      const customFetcher: HeliusFetcher = async () => [createTransaction("custom", 1, [])];
      assert.strictEqual(resolveHeliusFetcher({ heliusFetcher: customFetcher }, defaultFetcher), customFetcher);
    });

    it("returns custom fetcher from parent", () => {
      const defaultFetcher: HeliusFetcher = async () => [];
      const customFetcher: HeliusFetcher = async () => [createTransaction("custom", 1, [])];
      assert.strictEqual(resolveHeliusFetcher({ parent: { heliusFetcher: customFetcher } }, defaultFetcher), customFetcher);
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
    it("skips initialization when disabled", async (t: TestContext) => {
      const pollerService = createMockPollerService();
      const { app } = await buildPollerApp({ enabled: false, pollerService });
      t.after(() => app.close());
      assert.strictEqual(pollerService.pollers.length, 0);
    });

    it("starts poller on ready when enabled", async (t: TestContext) => {
      const pollerService = createMockPollerService();
      const { app } = await buildPollerApp({ enabled: true, pollerService });
      t.after(() => app.close());
      assert.strictEqual(pollerService.pollers.length, 1);
      assert.strictEqual(pollerService.pollers[0].started, true);
    });
  });

  describe("event processing", () => {
    it("processes outbound events", async (t: TestContext) => {
      const store = await setupAndRun(t, [createTransaction("sig1", 100, [toLogLine(createEventBytes("outbound"))])]);
      assert.strictEqual(store.length, 1);
      assert.strictEqual(store[0].signature, "sig1");
      assert.strictEqual(store[0].slot, 100);
      assert.strictEqual(store[0].type, "outbound");
    });

    it("processes override-outbound events", async (t: TestContext) => {
      const store = await setupAndRun(t, [createTransaction("sig2", 200, [toLogLine(createEventBytes("override"))])]);
      assert.strictEqual(store.length, 1);
      assert.strictEqual(store[0].type, "override-outbound");
    });

    it("ignores inbound events", async (t: TestContext) => {
      const store = await setupAndRun(t, [createTransaction("sig3", 300, [toLogLine(createEventBytes("inbound"))])]);
      assert.strictEqual(store.length, 0);
    });

    it("processes multiple transactions in one round", async (t: TestContext) => {
      const store = await setupAndRun(t, [
        createTransaction("sig6", 600, [toLogLine(createEventBytes("outbound"))]),
        createTransaction("sig7", 700, [toLogLine(createEventBytes("override"))]),
      ]);
      assert.strictEqual(store.length, 2);
      assert.strictEqual(store[0].signature, "sig6");
      assert.strictEqual(store[1].signature, "sig7");
    });
  });

  describe("transaction filtering", () => {
    it("skips transactions with errors", async (t: TestContext) => {
      const store = await setupAndRun(t, [
        createTransaction("sig4", 400, [toLogLine(createEventBytes("outbound"))], { err: "some error" }),
      ]);
      assert.strictEqual(store.length, 0);
    });

    it("skips transactions without log messages", async (t: TestContext) => {
      const store = await setupAndRun(t, [createTransaction("sig5", 500, null)]);
      assert.strictEqual(store.length, 0);
    });
  });

  describe("edge cases", () => {
    it("handles empty responses", async (t: TestContext) => {
      const store = await setupAndRun(t, []);
      assert.strictEqual(store.length, 0);
    });

    it("handles undefined responses array element", async (t: TestContext) => {
      const eventsRepository = createInMemoryEvents();
      const pollerService = createMockPollerService();
      const { app } = await buildPollerApp({ heliusFetcher: async () => [], eventsRepository, pollerService });
      t.after(() => app.close());
      await pollerService.pollers[0].onRound([]);
      assert.strictEqual(eventsRepository.store.length, 0);
    });

    it("logs error when event handling fails", async (t: TestContext) => {
      const failingRepository = {
        store: [] as StoredEvent[],
        create: async () => { throw new Error("Database error"); },
        listAfter: async () => [],
      };
      const store = await setupAndRun(
        t,
        [createTransaction("sig8", 800, [toLogLine(createEventBytes("outbound"))])],
        failingRepository as ReturnType<typeof createInMemoryEvents>
      );
      assert.strictEqual(store.length, 0);
    });

    it("deduplicates transactions across rounds", async (t: TestContext) => {
      const eventsRepository = createInMemoryEvents();
      const pollerService = createMockPollerService();
      const tx1 = createTransaction("sig-dup", 100, [toLogLine(createEventBytes("outbound"))]);
      const tx2 = createTransaction("sig-new", 101, [toLogLine(createEventBytes("outbound"))]);

      const { app } = await buildPollerApp({
        heliusFetcher: async () => [],
        eventsRepository,
        pollerService,
      });
      t.after(() => app.close());

      await pollerService.pollers[0].onRound([[tx1]]);
      assert.strictEqual(eventsRepository.store.length, 1);

      await pollerService.pollers[0].onRound([[tx1, tx2]]);
      assert.strictEqual(eventsRepository.store.length, 2);
      assert.strictEqual(eventsRepository.store[1].signature, "sig-new");
    });
  });
});
