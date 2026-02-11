import { describe, test, TestContext } from "node:test";
import { type Server } from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { build } from "../../helpers/build.js";
import {
  createTrackedServer,
  type TrackedServer,
} from "../../helpers/http-server.js";
import {
  computeRequiredSignatures,
  groupOrdersById,
  kOracleService,
  type OracleOrderWithSignature,
  type OracleService,
} from "../../../src/plugins/app/oracle-service.js";
import { FastifyInstance } from "fastify";
import { waitFor } from "../../helpers/wait-for.js";
import { buildCanonicalString } from "../../../src/plugins/infra/hub-signer.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import { HubKeys, kHubKeys } from "../../../src/plugins/infra/hub-keys.js";

const ORACLE_URLS = [
  "http://127.0.0.1:6101",
  "http://127.0.0.1:6102",
  "http://127.0.0.1:6103",
];

type ResponseMode = "data" | "array" | "empty";

const makeId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function orderBase(overrides: Partial<OracleOrderWithSignature> = {}) {
  return {
    id: makeId(1),
    signature: "sig",
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: "10",
    relayerFee: "1",
    origin_trx_hash: "trx-hash",
    source_nonce: "nonce",
    source_payload: "{\"v\":1}",
    oracle_accept_to_relay: false,
    status: "pending",
    ...overrides,
  } satisfies OracleOrderWithSignature;
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function closeAll(servers: TrackedServer[]) {
  return Promise.all(servers.map((entry) => entry.close()));
}

function createHealthServer(opts: {
  mode: "healthy" | "failing" | "slow";
  onHealthyRequest?: () => void;
  onRequest?: (headers: Record<string, string | string[] | undefined>) => void;
  now?: () => string;
}) {
  const { mode, onHealthyRequest, now } = opts;

  return createTrackedServer((req, res) => {
    if (req.url !== "/api/health") {
      res.writeHead(404).end();
      return;
    }

    opts.onRequest?.(req.headers);

    if (mode === "slow") {
      return;
    }

    if (mode === "failing") {
      res.writeHead(503).end();
      return;
    }

    onHealthyRequest?.();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: now?.() }));
  });
}

function createOrdersServer(opts: {
  handler: () => OracleOrderWithSignature[];
  responseMode?: ResponseMode;
  healthStatus?: "ok" | "down" | "slow";
  onHealthRequest?: (headers: Record<string, string | string[] | undefined>) => void;
  onOrdersRequest?: (headers: Record<string, string | string[] | undefined>) => void;
  ordersStatusCode?: number;
  responsePayload?: unknown;
}) {
  const {
    handler,
    responseMode = "data",
    healthStatus = "ok",
    ordersStatusCode,
    responsePayload,
  } = opts;

  return createTrackedServer(async (req, res) => {
    if (req.url === "/api/health") {
      opts.onHealthRequest?.(req.headers);
      if (healthStatus === "slow") {
        return;
      }

      if (healthStatus === "down") {
        res.writeHead(503).end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/api/orders" && req.method === "GET") {
      opts.onOrdersRequest?.(req.headers);
      if (healthStatus === "down") {
        res.writeHead(503).end();
        return;
      }
      if (ordersStatusCode && ordersStatusCode !== 200) {
        res.writeHead(ordersStatusCode).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });

      if (responsePayload !== undefined) {
        res.end(JSON.stringify(responsePayload));
        return;
      }

      const payload = handler();
      if (responseMode === "empty") {
        res.end(JSON.stringify({}));
        return;
      }

      res.end(
        JSON.stringify(responseMode === "array" ? payload : { data: payload })
      );
      return;
    }

    res.writeHead(404).end();
  });
}

function getOracleEntry(app: FastifyInstance, url: string) {
  return app
    .getDecorator<OracleService>(kOracleService)
    .list()
    .find((e) => e.url === url);
}

function getOrdersRepository(app: FastifyInstance) {
  return app.getDecorator<OrdersRepository>(kOrdersRepository);
}

function markOraclesHealthy(app: FastifyInstance, urls: string[]) {
  const oracleService = app.getDecorator<OracleService>(kOracleService);
  const timestamp = new Date().toISOString();
  for (const url of urls) {
    oracleService.update(url, { status: "ok", timestamp });
  }
}

function assertSignedHeaders(
  t: TestContext,
  headers: Record<string, string | string[] | undefined>,
  opts: { url: string; hubId: string; keyId: string; publicKeyPem: string }
) {
  const hubId = headers["x-hub-id"] as string;
  const keyId = headers["x-key-id"] as string;
  const timestamp = headers["x-timestamp"] as string;
  const nonce = headers["x-nonce"] as string;
  const bodyHash = headers["x-body-hash"] as string;
  const signature = headers["x-signature"] as string;

  t.assert.strictEqual(hubId, opts.hubId);
  t.assert.strictEqual(keyId, opts.keyId);

  const canonical = buildCanonicalString({
    method: "GET",
    url: opts.url,
    hubId,
    timestamp,
    nonce,
    bodyHash,
  });

  const expectedBodyHash = createHash("sha256").update("").digest("hex");
  t.assert.strictEqual(bodyHash, expectedBodyHash);

  const ok = verify(
    null,
    Buffer.from(canonical),
    createPublicKey(opts.publicKeyPem),
    Buffer.from(signature, "base64")
  );
  t.assert.ok(ok, "signature should verify");
}

async function withApp(t: TestContext) {
  const app = await build(t, {
    useMocks: false,
    config: { ORACLE_URLS: ORACLE_URLS.join(","), ORACLE_COUNT: ORACLE_URLS.length },
  });
  return app;
}

async function withServers(
  t: TestContext,
  servers: TrackedServer[],
  ports: number[]
) {
  await Promise.all(servers.map((s, i) => listen(s.server, ports[i])));
  t.after(() => closeAll(servers));
}

describe("oracle service", () => {
  test("lists env-configured urls", async (t: TestContext) => {
    const app = await withApp(t);
    const entries = app.getDecorator<OracleService>(kOracleService).list();

    t.assert.deepStrictEqual(
      entries.map((entry) => entry.url),
      ORACLE_URLS
    );
  });

  describe("poll health", () => {
    test("updates records", async (t: TestContext) => {
      const app = await withApp(t);
      const [first] = app.getDecorator<OracleService>(kOracleService).list();
      const timestamp = new Date("2024-01-01T00:00:00.000Z").toISOString();

      app
        .getDecorator<OracleService>(kOracleService)
        .update(first.url, { status: "ok", timestamp });

      const updated = getOracleEntry(app, first.url);
      t.assert.strictEqual(updated?.timestamp, timestamp);
    });

    test("groups orders by id", (t: TestContext) => {
      const orders: OracleOrderWithSignature[] = [
        orderBase({ id: makeId(1), signature: "sig1", status: "in-progress", amount: "1" }),
        orderBase({ id: makeId(2), signature: "sig2", status: "in-progress", amount: "2", from: "C", to: "D" }),
        orderBase({ id: makeId(1), signature: "sig3", status: "ready-for-relay", amount: "1" }),
      ];

      const grouped = groupOrdersById(orders);

      t.assert.strictEqual(grouped.length, 2);
      t.assert.strictEqual(grouped[0].length, 2);
      t.assert.strictEqual(grouped[0][0].id, makeId(1));
      t.assert.strictEqual(grouped[1][0].id, makeId(2));
    });

  test("polls remote health endpoints", async (t: TestContext) => {
    const [healthyUrl, failingUrl, slowUrl] = ORACLE_URLS;

    let healthyRequests = 0;
    const healthyHeaders: Record<string, string | string[] | undefined>[] = [];
    const start = Date.now();

    const healthyServer = createHealthServer({
      mode: "healthy",
      onHealthyRequest: () => {
        healthyRequests += 1;
      },
      onRequest: (headers) => {
        healthyHeaders.push(headers);
      },
      now: () => new Date(start + healthyRequests * 1_000).toISOString(),
    });

      const failingServer = createHealthServer({ mode: "failing" });
      const slowServer = createHealthServer({ mode: "slow" });

      await withServers(t, [healthyServer, failingServer, slowServer], [
        6101, 6102, 6103,
      ]);

      const app = await withApp(t);

      const initialEntries = new Map(
        app
          .getDecorator<OracleService>(kOracleService)
          .list()
          .map((entry) => [entry.url, entry])
      );

      await waitFor(async () => {
        const healthy = getOracleEntry(app, healthyUrl);
        const failing = getOracleEntry(app, failingUrl);
        const slow = getOracleEntry(app, slowUrl);

        return (
          healthy?.status === "ok" &&
          healthy?.timestamp !== initialEntries.get(healthyUrl)?.timestamp &&
          failing?.status === "down" &&
          slow?.status === "down"
        );
      });

      const snapshot = app.getDecorator<OracleService>(kOracleService).list();
      t.assert.strictEqual(
        snapshot.find((e) => e.url === healthyUrl)?.status,
        "ok"
      );
      t.assert.strictEqual(
        snapshot.find((e) => e.url === failingUrl)?.status,
        "down"
      );
      t.assert.strictEqual(
        snapshot.find((e) => e.url === slowUrl)?.status,
        "down"
      );

    await waitFor(async () => {
      const next = getOracleEntry(app, healthyUrl);
      return healthyRequests >= 2 && next !== undefined;
    });

    t.assert.ok(healthyRequests >= 2, "expected at least two polls to occur");
    t.assert.ok(healthyHeaders.length >= 1, "expected signed headers");

    const hubKeys = app.getDecorator<HubKeys>(kHubKeys);
    assertSignedHeaders(t, healthyHeaders[0], {
      url: "/api/health",
      hubId: hubKeys.hubId,
      keyId: hubKeys.current.kid,
      publicKeyPem: hubKeys.current.publicKeyPem,
    });

    if (healthyHeaders.length >= 2) {
      t.assert.notStrictEqual(
        healthyHeaders[0]["x-nonce"],
        healthyHeaders[1]["x-nonce"]
      );
    }
  });
});

  describe("poll orders", () => {
    function serverOrderFactory(
      signature: string,
      status: OracleOrderWithSignature["status"],
      overrides: Partial<OracleOrderWithSignature> = {}
    ) {
      return (id: string): OracleOrderWithSignature =>
        orderBase({ id, signature, status, ...overrides });
    }

    async function setupThreeOrderServers(
      t: TestContext,
      opts: {
        builders: Array<(id: string) => OracleOrderWithSignature>;
        responseModes?: [ResponseMode?, ResponseMode?, ResponseMode?];
        orderIds?: string[];
        healthStatuses?: [
          "ok" | "down" | "slow",
          "ok" | "down" | "slow",
          "ok" | "down" | "slow"
        ];
        ordersStatusCodes?: [number?, number?, number?];
        responsePayloads?: [unknown?, unknown?, unknown?];
        onOrdersRequests?: Array<
          (headers: Record<string, string | string[] | undefined>) => void
        >;
      }
    ) {
      const {
        builders,
        responseModes = ["data", "data", "data"],
        orderIds = [makeId(1)],
        healthStatuses = ["ok", "ok", "ok"],
        ordersStatusCodes = [],
        responsePayloads = [],
        onOrdersRequests = [],
      } = opts;

      const servers = [
        createOrdersServer({
          handler: () => orderIds.map(builders[0]),
          responseMode: responseModes[0],
          healthStatus: healthStatuses[0],
          ordersStatusCode: ordersStatusCodes[0],
          responsePayload: responsePayloads[0],
          onOrdersRequest: onOrdersRequests[0],
        }),
        createOrdersServer({
          handler: () => orderIds.map(builders[1]),
          responseMode: responseModes[1],
          healthStatus: healthStatuses[1],
          ordersStatusCode: ordersStatusCodes[1],
          responsePayload: responsePayloads[1],
          onOrdersRequest: onOrdersRequests[1],
        }),
        createOrdersServer({
          handler: () => orderIds.map(builders[2]),
          responseMode: responseModes[2],
          healthStatus: healthStatuses[2],
          ordersStatusCode: ordersStatusCodes[2],
          responsePayload: responsePayloads[2],
          onOrdersRequest: onOrdersRequests[2],
        }),
      ];

      await withServers(t, servers, [6101, 6102, 6103]);
      return servers;
    }

    test("reconciles orders from three servers by majority status", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "pending"),
        ],
        responseModes: ["data", "data", "array"],
        orderIds: [makeId(101)],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);

      const created = await ordersRepository.create({
        id: makeId(101),
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-hash",
        oracle_accept_to_relay: false,
        status: "pending",
      });

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const updated = await ordersRepository.findById(created!.id);
        return updated?.status === "finalized";
      }, 10_000);

      await handle.stop();

      const updated = await ordersRepository.findById(created!.id);
      t.assert.strictEqual(updated?.status, "finalized");

      const withSignatures = await ordersRepository.findByIdsWithSignatures([
        created!.id,
      ]);
      t.assert.strictEqual(withSignatures[0].signatures.length, 3);
    });

    test("marks orders ready-for-relay when signature threshold is met", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "pending"),
          serverOrderFactory("sig-2", "pending"),
          serverOrderFactory("sig-3", "pending"),
        ],
        responseModes: ["data", "data", "array"],
        orderIds: [makeId(151)],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);

      const created = await ordersRepository.create({
        id: makeId(151),
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-hash",
        oracle_accept_to_relay: false,
        status: "pending",
      });

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const updated = await ordersRepository.findById(created!.id);
        return updated?.status === "ready-for-relay";
      }, 15_000);

      await handle.stop();

      const updated = await ordersRepository.findById(created!.id);
      t.assert.strictEqual(updated?.status, "ready-for-relay");
      t.assert.strictEqual(updated?.oracle_accept_to_relay, false);
    });

    test("computes required signature thresholds", (t: TestContext) => {
      t.assert.strictEqual(computeRequiredSignatures(0.6, 3), 2);
      t.assert.strictEqual(computeRequiredSignatures(3, 6), 3);
      t.assert.strictEqual(computeRequiredSignatures(-1, 0), 1);
    });

    test("keeps orders pending when signature threshold is not met", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "pending"),
          serverOrderFactory("sig-2", "pending"),
          serverOrderFactory("sig-3", "pending"),
        ],
        orderIds: [makeId(161)],
        healthStatuses: ["ok", "down", "down"],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, [ORACLE_URLS[0]]);

      const created = await ordersRepository.create({
        id: makeId(161),
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-hash",
        oracle_accept_to_relay: false,
        status: "pending",
      });

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const withSignatures =
          await ordersRepository.findByIdsWithSignatures([created!.id]);
        return withSignatures[0]?.signatures.length === 1;
      }, 10_000);

      await handle.stop();

      const updated = await ordersRepository.findById(created!.id);
      t.assert.strictEqual(updated?.status, "pending");
      t.assert.strictEqual(updated?.oracle_accept_to_relay, false);

      const withSignatures = await ordersRepository.findByIdsWithSignatures([
        created!.id,
      ]);
      t.assert.strictEqual(withSignatures[0].signatures.length, 1);
    });

    test("logs when oracle orders polling fails", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        orderIds: [makeId(111)],
        ordersStatusCodes: [503, 200, 200],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) => call.arguments[1] === "oracle orders poll failed"
        )
      );

      await handle.stop();
    });

    test("logs when oracle orders payload is invalid", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        responsePayloads: [{ data: "nope" }, { data: "nope" }, { data: "nope" }],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) => call.arguments[1] === "oracle orders poll returned invalid payload"
        )
      );

      const [logPayload] = warnMock.calls.find(
        (call) => call.arguments[1] === "oracle orders poll returned invalid payload"
      )!.arguments as [{ payloadType: string; payloadKeys: string[] }];
      t.assert.strictEqual(logPayload.payloadType, "object");
      t.assert.deepStrictEqual(logPayload.payloadKeys, ["data"]);

      await handle.stop();
    });

    test("logs payload metadata when oracle returns non-object payload", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        responsePayloads: ["nope", "nope", "nope"],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) => call.arguments[1] === "oracle orders poll returned invalid payload"
        )
      );

      const [logPayload] = warnMock.calls.find(
        (call) => call.arguments[1] === "oracle orders poll returned invalid payload"
      )!.arguments as [{ payloadType: string; payloadKeys: string[] }];
      t.assert.strictEqual(logPayload.payloadType, "string");
      t.assert.deepStrictEqual(logPayload.payloadKeys, []);

      await handle.stop();
    });

    test("logs payload metadata when oracle returns invalid array payload", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        responsePayloads: [[1], [1], [1]],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) => call.arguments[1] === "oracle orders poll returned invalid payload"
        )
      );

      const [logPayload] = warnMock.calls.find(
        (call) => call.arguments[1] === "oracle orders poll returned invalid payload"
      )!.arguments as [{ payloadType: string; payloadKeys: string[] }];
      t.assert.strictEqual(logPayload.payloadType, "array");
      t.assert.deepStrictEqual(logPayload.payloadKeys, ["0"]);

      await handle.stop();
    });

    test("skips unhealthy oracles when polling orders", async (t: TestContext) => {
      let downCalls = 0;

      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          (id) => {
            downCalls += 1;
            return orderBase({ id, signature: "sig-3", status: "finalized" });
          },
        ],
        orderIds: [makeId(1)],
        healthStatuses: ["ok", "ok", "down"],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, [ORACLE_URLS[0], ORACLE_URLS[1]]); // Don't set the third healthy

      const created = await ordersRepository.create({
        id: makeId(1),
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-hash",
        oracle_accept_to_relay: false,
        status: "pending",
      });

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const updated = await ordersRepository.findById(created!.id);
        return updated?.status === "finalized";
      }, 10_000);

      await handle.stop();

      const withSignatures = await ordersRepository.findByIdsWithSignatures([
        created!.id,
      ]);
      t.assert.strictEqual(
        withSignatures[0].signatures.length,
        2,
        `expected 2 signatures, got ${withSignatures[0].signatures.length}`
      );
      t.assert.strictEqual(
        downCalls,
        0,
        `expected down oracle to be skipped, downCalls=${downCalls}`
      );
    });

    test("signs oracle orders requests", async (t: TestContext) => {
      const ordersHeaders: Record<string, string | string[] | undefined>[] = [];

      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        orderIds: [makeId(999)],
        responseModes: ["data", "data", "data"],
        healthStatuses: ["ok", "ok", "ok"],
        onOrdersRequests: [
          (headers) => ordersHeaders.push(headers),
        ],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() => ordersHeaders.length >= 1, 10_000);

      const hubKeys = app.getDecorator<HubKeys>(kHubKeys);
      assertSignedHeaders(t, ordersHeaders[0], {
        url: "/api/orders",
        hubId: hubKeys.hubId,
        keyId: hubKeys.current.kid,
        publicKeyPem: hubKeys.current.publicKeyPem,
      });

      await handle.stop();
    });

    test("logs when reconciliation fails for mismatched orders", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized", { amount: "11" }),
        ],
        orderIds: [makeId(201)],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);
      await ordersRepository.create({
        id: makeId(201),
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-hash",
        oracle_accept_to_relay: false,
        status: "pending",
      });

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) =>
            call.arguments[1] === "oracle orders reconciliation failed"
        )
      );

      await handle.stop();
    });

    test("creates missing orders when polling oracles", async (t: TestContext) => {
      const orderId = makeId(250);
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        orderIds: [orderId],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const created = await ordersRepository.findById(orderId);
        return created?.status === "finalized";
      }, 10_000);

      const withSignatures = await ordersRepository.findByIdsWithSignatures([
        orderId,
      ]);
      t.assert.strictEqual(withSignatures[0].signatures.length, 3);

      await handle.stop();
    });

    test("stores extra oracle fields when creating missing orders", async (t: TestContext) => {
      const orderId = makeId(251);
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized", {
            source_nonce: "nonce",
            source_payload: "{\"v\":1}",
          }),
          serverOrderFactory("sig-2", "finalized", {
            source_nonce: "nonce",
            source_payload: "{\"v\":1}",
          }),
          serverOrderFactory("sig-3", "finalized", {
            source_nonce: "nonce",
            source_payload: "{\"v\":1}",
          }),
        ],
        orderIds: [orderId],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);

      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const created = await ordersRepository.findById(orderId);
        return created?.status === "finalized";
      }, 10_000);

      const created = await ordersRepository.findById(orderId);
      t.assert.strictEqual(created?.source, "solana");
      t.assert.strictEqual(created?.source_nonce, "nonce");
      t.assert.strictEqual(created?.source_payload, "{\"v\":1}");

      await handle.stop();
    });

    test("logs when order creation fails during reconciliation", async (t: TestContext) => {
      const orderId = makeId(260);
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        orderIds: [orderId],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);

      const { mock: createMock } = t.mock.method(ordersRepository, "create");
      createMock.mockImplementation(async () => null);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) =>
            call.arguments[1] === "oracle orders poll skipped missing order"
        )
      );

      await handle.stop();
    });

    test("logs when an order is missing during reconciliation", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        responseModes: ["data", "data", "empty"],
        orderIds: [makeId(301)],
      });

      const app = await withApp(t);
      const ordersRepository = getOrdersRepository(app);
      markOraclesHealthy(app, ORACLE_URLS);
      const created = await ordersRepository.create({
        id: makeId(301),
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-hash",
        oracle_accept_to_relay: false,
        status: "pending",
      });

      const { mock: updateMock } = t.mock.method(ordersRepository, "update");
      updateMock.mockImplementation(async () => null);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.getDecorator<OracleService>(kOracleService).pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) =>
            call.arguments[1] === "oracle orders poll skipped missing order"
        )
      );

      await handle.stop();

      const fetched = await ordersRepository.findById(created!.id);
      t.assert.strictEqual(fetched?.status, "pending");
    });
  });
});
