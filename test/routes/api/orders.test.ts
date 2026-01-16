import { test, TestContext } from "node:test";
import { build } from "../../helpers/build.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";

async function seedOrders(app: Awaited<ReturnType<typeof build>>) {
  const ordersRepository =
    app.getDecorator<OrdersRepository>(kOrdersRepository);
  await ordersRepository.create({
    id: 401,
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: 10,
    oracle_accept_to_relay: false,
    status: "in-progress",
  });
  await ordersRepository.create({
    id: 402,
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: 25,
    oracle_accept_to_relay: false,
    status: "finalized",
  });
}

test("GET /api/orders returns paginated list", async (t: TestContext) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    url: "/api/orders?page=1&limit=1&order=asc&dest=qubic",
    method: "GET",
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
  t.assert.strictEqual(body.data[0].oracle_accept_to_relay, false);
});

test("GET /api/orders/signatures returns stored signatures", async (t: TestContext) => {
  const app = await build(t);
  const ordersRepository =
    app.getDecorator<OrdersRepository>(kOrdersRepository);

  const first = await ordersRepository.create({
    id: 501,
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: 10,
    oracle_accept_to_relay: true,
    status: "ready-for-relay",
  });
  const second = await ordersRepository.create({
    id: 502,
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: 20,
    oracle_accept_to_relay: false,
    status: "in-progress",
  });
  await ordersRepository.create({
    id: 503,
    source: "qubic",
    dest: "solana",
    from: "E",
    to: "F",
    amount: 30,
    oracle_accept_to_relay: false,
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
    body.data.map((order: { orderId: number; signatures: string[] }) => [
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
    url: "/api/orders",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logPayload, logMsg] = logMock.calls[0].arguments as any;
  t.assert.strictEqual(logMsg, "Failed to list orders");
  t.assert.strictEqual(logPayload.err.message, "db down");

  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Internal Server Error");
});
