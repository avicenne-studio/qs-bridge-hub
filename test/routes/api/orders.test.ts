import { test, TestContext } from "node:test";
import { build } from "../../helpers/build.js";
import { kKnex, type KnexAccessor } from "../../../src/plugins/infra/knex.js";
import {
  ORDERS_TABLE_NAME,
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import {
  kFeeEstimation,
} from "../../../src/plugins/app/fee-estimation/fee-estimation.js";

const makeId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

async function seedOrders(app: Awaited<ReturnType<typeof build>>) {
  const ordersRepository =
    app.getDecorator<OrdersRepository>(kOrdersRepository);
  await ordersRepository.create({
    id: makeId(401),
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: "10",
    relayerFee: "1",
    origin_trx_hash: "trx-hash",
    source_nonce: "nonce",
    source_payload: "{\"v\":1}",
    status: "in-progress",
  });
  await ordersRepository.create({
    id: makeId(402),
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: "25",
    relayerFee: "1",
    origin_trx_hash: "trx-hash",
    source_nonce: "nonce",
    source_payload: "{\"v\":1}",
    status: "finalized",
  });
}

test("GET /api/orders returns paginated list", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    method: "GET",
    url: "/api/orders",
    query: { page: "1", limit: "1", order: "asc", dest: "qubic" },
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);

  t.assert.deepStrictEqual(body.pagination, {
    page: 1,
    limit: 1,
    total: 1,
  });
  t.assert.strictEqual(body.data.length, 1);
  t.assert.strictEqual(body.data[0].from, "A");
  t.assert.strictEqual(body.data[0].dest, "qubic");
  t.assert.strictEqual(body.data[0].status, "in-progress");
});

test("GET /api/orders filters by status (multiple)", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    method: "GET",
    url: "/api/orders",
    query: { page: "1", limit: "10", status: ["in-progress", "finalized"] },
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.length, 2);
  t.assert.strictEqual(body.pagination.total, 2);
});

test("GET /api/orders filters by from", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const resFrom = await app.inject({
    method: "GET",
    url: "/api/orders",
    query: { page: "1", limit: "10", from: "A" },
  });
  t.assert.strictEqual(resFrom.statusCode, 200);
  const bodyFrom = JSON.parse(resFrom.payload);
  t.assert.strictEqual(bodyFrom.data.length, 1);
  t.assert.strictEqual(bodyFrom.data[0].from, "A");
  t.assert.strictEqual(bodyFrom.data[0].id, makeId(401));

  const resTo = await app.inject({
    method: "GET",
    url: "/api/orders",
    query: { page: "1", limit: "10", to: "D" },
  });
  t.assert.strictEqual(resTo.statusCode, 200);
  const bodyTo = JSON.parse(resTo.payload);
  t.assert.strictEqual(bodyTo.data.length, 1);
  t.assert.strictEqual(bodyTo.data[0].to, "D");
  t.assert.strictEqual(bodyTo.data[0].id, makeId(402));
});

test("GET /api/orders filters by amount_min and amount_max", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    method: "GET",
    url: "/api/orders",
    query: { page: "1", limit: "10", amount_min: "15", amount_max: "30" },
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.length, 1);
  t.assert.strictEqual(body.data[0].amount, "25");
  t.assert.strictEqual(body.data[0].id, makeId(402));
});

test("GET /api/orders filters by id", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const orderId = makeId(401);
  const res = await app.inject({
    method: "GET",
    url: "/api/orders",
    query: { page: "1", limit: "10", id: orderId },
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.length, 1);
  t.assert.strictEqual(body.data[0].id, orderId);
  t.assert.strictEqual(body.data[0].from, "A");
});

test("GET /api/orders filters by created_after and created_before", async (t: TestContext) => {
  const app = await build(t);
  const knex = app.getDecorator<KnexAccessor>(kKnex).get();

  const dateOld = "1970-06-01T00:00:00.000Z";
  const dateMid = "2000-06-01T00:00:00.000Z";
  const dateNew = "2099-06-01T00:00:00.000Z";
  const dateBetweenOldAndMid = "1980-01-01T00:00:00.000Z";
  const dateAfterNew = "2100-01-01T00:00:00.000Z";

  const row = {
    source: "solana",
    dest: "qubic",
    from: "X",
    to: "Y",
    amount: "1",
    relayerFee: "1",
    origin_trx_hash: "tx",
    source_nonce: "n",
    source_payload: "{}",
    oracle_accept_to_relay: false,
    status: "in-progress" as const,
  };
  await knex(ORDERS_TABLE_NAME).insert([
    { ...row, id: makeId(501), created_at: dateOld },
    { ...row, id: makeId(502), created_at: dateMid },
    { ...row, id: makeId(503), created_at: dateNew },
  ]);

  async function total(query: Record<string, string>) {
    const res = await app.inject({
      method: "GET",
      url: "/api/orders",
      query: { page: "1", limit: "10", ...query },
    });
    t.assert.strictEqual(res.statusCode, 200);
    return JSON.parse(res.payload).pagination.total;
  }

  t.assert.strictEqual(await total({ created_after: dateOld, created_before: dateNew }), 3); 
  t.assert.strictEqual(await total({ created_after: dateOld, created_before: dateBetweenOldAndMid }), 1); 
  t.assert.strictEqual(await total({ created_after: dateMid, created_before: dateNew }), 2); 
  t.assert.strictEqual(await total({ created_after: dateAfterNew }), 0);
});

test("GET /api/orders/trx-hash returns order by transaction hash", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    method: "GET",
    url: "/api/orders/trx-hash",
    query: { hash: "trx-hash" },
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.origin_trx_hash, "trx-hash");
  t.assert.strictEqual(body.data.id, makeId(401));
});

test("GET /api/orders/trx-hash returns 404 when order is missing", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    method: "GET",
    url: "/api/orders/trx-hash",
    query: { hash: "missing" },
  });

  t.assert.strictEqual(res.statusCode, 404);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Order not found");
});

test("GET /api/orders/signatures returns stored signatures", async (t: TestContext) => {
  const app = await build(t);
  const ordersRepository =
    app.getDecorator<OrdersRepository>(kOrdersRepository);

  const first = await ordersRepository.create({
    id: makeId(501),
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: "10",
    relayerFee: "1",
    origin_trx_hash: "trx-hash",
    source_nonce: "nonce",
    source_payload: "{\"v\":1}",
    status: "ready-for-relay",
  });
  const second = await ordersRepository.create({
    id: makeId(502),
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: "20",
    relayerFee: "1",
    origin_trx_hash: "trx-hash",
    source_nonce: "nonce",
    source_payload: "{\"v\":1}",
    status: "in-progress",
  });
  await ordersRepository.create({
    id: makeId(503),
    source: "qubic",
    dest: "solana",
    from: "E",
    to: "F",
    amount: "30",
    relayerFee: "1",
    origin_trx_hash: "trx-hash",
    source_nonce: "nonce",
    source_payload: "{\"v\":1}",
    status: "finalized",
  });

  await ordersRepository.addSignatures(first!.id, ["sigA", "sigB"]);
  await ordersRepository.addSignatures(second!.id, ["sigC"]);

  const res = await app.inject({
    url: "/api/orders/signatures",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.length, 1);

  const byId = new Map(
    body.data.map((order: { orderId: string; signatures: string[] }) => [
      order.orderId,
      order.signatures.slice().sort(),
    ])
  );

  t.assert.deepStrictEqual(byId.get(first!.id), ["sigA", "sigB"]);
  t.assert.deepStrictEqual(byId.get(second!.id), undefined);
});

test("GET /api/orders handles repository errors", async (t: TestContext) => {
  const app = await build(t);
  const ordersRepository =
    app.getDecorator<OrdersRepository>(kOrdersRepository);
  const { mock: repoMock } = t.mock.method(ordersRepository, "paginate");
  repoMock.mockImplementation(() => {
    throw new Error("db down");
  });

  const { mock: logMock } = t.mock.method(app.log, "error");

  const res = await app.inject({
    method: "GET",
    url: "/api/orders",
  });

  t.assert.strictEqual(res.statusCode, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logPayload, logMsg] = logMock.calls[0].arguments as any;
  t.assert.strictEqual(logMsg, "Failed to list orders");
  t.assert.strictEqual(logPayload.err.message, "db down");

  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Internal Server Error");
});

const VALID_ESTIMATION_PAYLOAD = {
  networkIn: 2,
  networkOut: 1,
  fromAddress: "46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV",
  toAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amount: "1000000",
};

test("POST /api/orders/estimate returns fee breakdown", async (t: TestContext) => {
  const fakeFeeEstimation = {
    estimate: t.mock.fn(() =>
      Promise.resolve({
        bridgeFee: { oracleFee: "10000", protocolFee: "1000", total: "11000" },
        relayerFee: "1",
        networkFee: "2190440",
        userReceives: "988999",
      }),
    ),
  };

  const app = await build(t, {
    decorators: { [kFeeEstimation]: fakeFeeEstimation },
  });

  const res = await app.inject({
    url: "/api/orders/estimate",
    method: "POST",
    payload: VALID_ESTIMATION_PAYLOAD,
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.bridgeFee.total, "11000");
  t.assert.strictEqual(body.data.relayerFee, "1");
  t.assert.strictEqual(body.data.networkFee, "2190440");
  t.assert.strictEqual(body.data.userReceives, "988999");
  t.assert.strictEqual(fakeFeeEstimation.estimate.mock.callCount(), 1);
});

test("POST /api/orders/estimate returns 400 for invalid payload", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/orders/estimate",
    method: "POST",
    payload: {
      networkIn: 2,
      networkOut: 1,
      fromAddress: "not-a-valid-base58!",
      toAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "1000000",
    },
  });

  t.assert.strictEqual(res.statusCode, 400);
});

test("POST /api/orders/estimate returns 500 on service error", async (t: TestContext) => {
  const fakeFeeEstimation = {
    estimate: t.mock.fn(() => Promise.reject(new Error("RPC unreachable"))),
  };

  const app = await build(t, {
    decorators: { [kFeeEstimation]: fakeFeeEstimation },
  });

  const { mock: logMock } = t.mock.method(app.log, "error");

  const res = await app.inject({
    url: "/api/orders/estimate",
    method: "POST",
    payload: VALID_ESTIMATION_PAYLOAD,
  });

  t.assert.strictEqual(res.statusCode, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logPayload, logMsg] = logMock.calls[0].arguments as any;
  t.assert.strictEqual(logMsg, "Unhandled error occurred");
  t.assert.strictEqual(logPayload.err.message, "RPC unreachable");

  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Internal Server Error");
});

test("POST /api/orders/estimate returns 503 when no healthy oracles", async (t: TestContext) => {
  const err = new Error(
    "Cannot estimate fees: at least 4 healthy oracles required",
  ) as Error & {
    statusCode?: number;
  };
  err.statusCode = 503;
  const fakeFeeEstimation = {
    estimate: t.mock.fn(() => Promise.reject(err)),
  };

  const app = await build(t, {
    decorators: { [kFeeEstimation]: fakeFeeEstimation },
  });

  const res = await app.inject({
    url: "/api/orders/estimate",
    method: "POST",
    payload: VALID_ESTIMATION_PAYLOAD,
  });

  t.assert.strictEqual(res.statusCode, 503);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Internal Server Error");
});
