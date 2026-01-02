import { describe, test, TestContext } from "node:test";
import { createServer, type Server } from "node:http";
import { build, waitFor } from "../../helper.js";
import { groupOrdersById } from "../../../src/plugins/app/oracle-service.js";
import type { OracleOrderWithSignature } from "../../../src/plugins/app/oracle-service.js";
import { FastifyInstance } from "fastify";

const ORACLE_URLS = [
  "http://127.0.0.1:6101",
  "http://127.0.0.1:6102",
  "http://127.0.0.1:6103",
] as const;

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

async function readJson(req: NodeJS.ReadableStream) {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  return body.length > 0 ? JSON.parse(body) : {};
}

function createHealthServer(opts: {
  mode: "healthy" | "failing" | "slow";
  onHealthyRequest?: () => void;
  now?: () => string;
}) {
  const { mode, onHealthyRequest, now } = opts;

  return createServer((req, res) => {
    if (req.url !== "/api/health") {
      res.writeHead(404).end();
      return;
    }

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
  handler: (ids: number[]) => OracleOrderWithSignature[];
  responseMode?: ResponseMode;
}) {
  const { handler, responseMode = "data" } = opts;

  return createServer(async (req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/api/orders" && req.method === "POST") {
      const { ids } = await readJson(req);
      const payload = handler((ids ?? []) as number[]);

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
      const start = Date.now();

      const healthyServer = createHealthServer({
        mode: "healthy",
        onHealthyRequest: () => {
          healthyRequests += 1;
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
      }
    ) {
      const { builders, responseModes = ["data", "data", "data"] } = opts;

      const servers = [
        createOrdersServer({
          handler: (ids) => ids.map(builders[0]),
          responseMode: responseModes[0],
        }),
        createOrdersServer({
          handler: (ids) => ids.map(builders[1]),
          responseMode: responseModes[1],
        }),
        createOrdersServer({
          handler: (ids) => ids.map(builders[2]),
          responseMode: responseModes[2],
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
      });

      const app = await withApp(t);

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

    test("logs when reconciliation fails for mismatched orders", async (t: TestContext) => {
      await setupThreeOrderServers(t, {
        builders: [
          serverOrderFactory("sig-1", "finalized"),
          serverOrderFactory("sig-2", "finalized"),
          serverOrderFactory("sig-3", "finalized", { amount: 11 }),
        ],
      });

      const app = await withApp(t);
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
      });

      const app = await withApp(t);
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
