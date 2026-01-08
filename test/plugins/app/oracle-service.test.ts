import { describe, test, TestContext } from "node:test";
import { createServer, type Server } from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { build } from "../../helpers/build.js";
import { groupOrdersById } from "../../../src/plugins/app/oracle-service.js";
import type { OracleOrderWithSignature } from "../../../src/plugins/app/oracle-service.js";
import { FastifyInstance } from "fastify";
import { waitFor } from "../../helpers/wait-for.js";
import { buildCanonicalString } from "../../../src/plugins/infra/hub-signer.js";

const ORACLE_URLS = [
  "http://127.0.0.1:6101",
  "http://127.0.0.1:6102",
  "http://127.0.0.1:6103",
];

type ResponseMode = "data" | "array" | "empty";

function orderBase(overrides: Partial<OracleOrderWithSignature> = {}) {
  return {
    id: 1,
    signature: "sig",
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: 10,
    is_relayable: false,
    status: "pending",
    ...overrides,
  } satisfies OracleOrderWithSignature;
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve) => server.listen(port, resolve));
}

function closeAll(servers: Server[]) {
  servers.forEach((s) => s.close());
}

function createHealthServer(opts: {
  mode: "healthy" | "failing" | "slow";
  onHealthyRequest?: () => void;
  onRequest?: (headers: Record<string, string | string[] | undefined>) => void;
  now?: () => string;
}) {
  const { mode, onHealthyRequest, now } = opts;

  return createServer((req, res) => {
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
}) {
  const {
    handler,
    responseMode = "data",
    healthStatus = "ok",
    ordersStatusCode,
  } = opts;

  return createServer(async (req, res) => {
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
      if (ordersStatusCode && ordersStatusCode !== 200) {
        res.writeHead(ordersStatusCode).end();
        return;
      }
      const payload = handler();

      res.writeHead(200, { "content-type": "application/json" });

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
  return app.oracleService.list().find((e) => e.url === url);
}

function markOraclesHealthy(app: FastifyInstance, urls: string[]) {
  const timestamp = new Date().toISOString();
  for (const url of urls) {
    app.oracleService.update(url, { status: "ok", timestamp });
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
  const app = await build(t);
  return app;
}

async function withServers(
  t: TestContext,
  servers: Server[],
  ports: number[]
) {
  await Promise.all(servers.map((s, i) => listen(s, ports[i])));
  t.after(() => closeAll(servers));
}

describe("oracle service", () => {
  test("lists env-configured urls", async (t: TestContext) => {
    const app = await withApp(t);
    const entries = app.oracleService.list();

    t.assert.deepStrictEqual(
      entries.map((entry) => entry.url),
      ORACLE_URLS
    );
  });

  describe("poll health", () => {
    test("updates records", async (t: TestContext) => {
      const app = await withApp(t);
      const [first] = app.oracleService.list();
      const timestamp = new Date("2024-01-01T00:00:00.000Z").toISOString();

      app.oracleService.update(first.url, { status: "ok", timestamp });

      const updated = getOracleEntry(app, first.url);
      t.assert.strictEqual(updated?.timestamp, timestamp);
    });

    test("groups orders by id", (t: TestContext) => {
      const orders: OracleOrderWithSignature[] = [
        orderBase({ id: 1, signature: "sig1", status: "in-progress", amount: 1 }),
        orderBase({ id: 2, signature: "sig2", status: "in-progress", amount: 2, from: "C", to: "D" }),
        orderBase({ id: 1, signature: "sig3", status: "ready-for-relay", amount: 1 }),
      ];

      const grouped = groupOrdersById(orders);

      t.assert.strictEqual(grouped.length, 2);
      t.assert.strictEqual(grouped[0].length, 2);
      t.assert.strictEqual(grouped[0][0].id, 1);
      t.assert.strictEqual(grouped[1][0].id, 2);
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
        app.oracleService.list().map((entry) => [entry.url, entry])
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

      const snapshot = app.oracleService.list();
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

    assertSignedHeaders(t, healthyHeaders[0], {
      url: "/api/health",
      hubId: app.hubKeys.hubId,
      keyId: app.hubKeys.current.kid,
      publicKeyPem: app.hubKeys.current.publicKeyPem,
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
      return (id: number): OracleOrderWithSignature =>
        orderBase({ id, signature, status, ...overrides });
    }

    async function setupThreeOrderServers(
      t: TestContext,
      opts: {
        builders: Array<(id: number) => OracleOrderWithSignature>;
        responseModes?: [ResponseMode?, ResponseMode?, ResponseMode?];
        orderIds?: number[];
        healthStatuses?: [
          "ok" | "down" | "slow",
          "ok" | "down" | "slow",
          "ok" | "down" | "slow"
        ];
        ordersStatusCodes?: [number?, number?, number?];
        onOrdersRequests?: Array<
          (headers: Record<string, string | string[] | undefined>) => void
        >;
      }
    ) {
      const {
        builders,
        responseModes = ["data", "data", "data"],
        orderIds = [1],
        healthStatuses = ["ok", "ok", "ok"],
        ordersStatusCodes = [],
        onOrdersRequests = [],
      } = opts;

      const servers = [
        createOrdersServer({
          handler: () => orderIds.map(builders[0]),
          responseMode: responseModes[0],
          healthStatus: healthStatuses[0],
          ordersStatusCode: ordersStatusCodes[0],
          onOrdersRequest: onOrdersRequests[0],
        }),
        createOrdersServer({
          handler: () => orderIds.map(builders[1]),
          responseMode: responseModes[1],
          healthStatus: healthStatuses[1],
          ordersStatusCode: ordersStatusCodes[1],
          onOrdersRequest: onOrdersRequests[1],
        }),
        createOrdersServer({
          handler: () => orderIds.map(builders[2]),
          responseMode: responseModes[2],
          healthStatus: healthStatuses[2],
          ordersStatusCode: ordersStatusCodes[2],
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
        orderIds: [101],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const created = await app.ordersRepository.create({
        id: 101,
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: 10,
        is_relayable: false,
        status: "pending",
      });

      const handle = app.oracleService.pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const updated = await app.ordersRepository.findById(created!.id);
        return updated?.status === "finalized";
      }, 10_000);

      await handle.stop();

      const updated = await app.ordersRepository.findById(created!.id);
      t.assert.strictEqual(updated?.status, "finalized");

      const withSignatures = await app.ordersRepository.findByIdsWithSignatures([
        created!.id,
      ]);
      t.assert.strictEqual(withSignatures[0].signatures.length, 3);
    });

    test("logs when oracle orders polling fails", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        orderIds: [111],
        ordersStatusCodes: [503, 200, 200],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.oracleService.pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) => call.arguments[1] === "oracle orders poll failed"
        )
      );

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
        orderIds: [1],
        healthStatuses: ["ok", "ok", "down"],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, [ORACLE_URLS[0], ORACLE_URLS[1]]); // Don't set the third healthy

      const created = await app.ordersRepository.create({
        id: 1,
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: 10,
        is_relayable: false,
        status: "pending",
      });

      const handle = app.oracleService.pollOrders();
      t.after(() => handle.stop());

      await waitFor(async () => {
        const updated = await app.ordersRepository.findById(created!.id);
        return updated?.status === "finalized";
      }, 10_000);

      await handle.stop();

      const withSignatures = await app.ordersRepository.findByIdsWithSignatures([
        created!.id,
      ]);
      t.assert.strictEqual(withSignatures[0].signatures.length, 2);
      t.assert.strictEqual(downCalls, 0);
    });

    test("signs oracle orders requests", async (t: TestContext) => {
      const ordersHeaders: Record<string, string | string[] | undefined>[] = [];

      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized"),
        ],
        orderIds: [999],
        responseModes: ["data", "data", "data"],
        healthStatuses: ["ok", "ok", "ok"],
        onOrdersRequests: [
          (headers) => ordersHeaders.push(headers),
        ],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);

      const handle = app.oracleService.pollOrders();
      t.after(() => handle.stop());

      await waitFor(() => ordersHeaders.length >= 1, 10_000);

      assertSignedHeaders(t, ordersHeaders[0], {
        url: "/api/orders",
        hubId: app.hubKeys.hubId,
        keyId: app.hubKeys.current.kid,
        publicKeyPem: app.hubKeys.current.publicKeyPem,
      });

      await handle.stop();
    });

    test("logs when reconciliation fails for mismatched orders", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized", { amount: 11 }),
        ],
        orderIds: [201],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);
      await app.ordersRepository.create({
        id: 201,
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: 10,
        is_relayable: false,
        status: "pending",
      });

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.oracleService.pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) =>
            call.arguments[1] === "oracle orders reconciliation failed"
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
        orderIds: [301],
      });

      const app = await withApp(t);
      markOraclesHealthy(app, ORACLE_URLS);
      const created = await app.ordersRepository.create({
        id: 301,
        source: "solana",
        dest: "qubic",
        from: "A",
        to: "B",
        amount: 10,
        is_relayable: false,
        status: "pending",
      });

      const { mock: updateMock } = t.mock.method(app.ordersRepository, "update");
      updateMock.mockImplementation(async () => null);

      const { mock: warnMock } = t.mock.method(app.log, "warn");
      const handle = app.oracleService.pollOrders();
      t.after(() => handle.stop());

      await waitFor(() =>
        warnMock.calls.some(
          (call) =>
            call.arguments[1] === "oracle orders poll skipped missing order"
        )
      );

      await handle.stop();

      const fetched = await app.ordersRepository.findById(created!.id);
      t.assert.strictEqual(fetched?.status, "pending");
    });
  });
});
