import { test } from "node:test";
import assert from "node:assert";
import { build } from "../../helper.js";

async function seedOrders(app: Awaited<ReturnType<typeof build>>) {
  await app.ordersRepository.create({
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: 10,
    status: "in-progress",
  });
  await app.ordersRepository.create({
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: 25,
    status: "finalized",
  });
}

test("GET /api/orders returns paginated list", async (t) => {
  const app = await build(t);
  await seedOrders(app);

  const res = await app.inject({
    url: "/api/orders?page=1&limit=1&order=asc&dest=qubic",
    method: "GET",
  });

  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);

  assert.deepStrictEqual(body.pagination, {
    page: 1,
    limit: 1,
    total: 1,
  });
  assert.strictEqual(body.data.length, 1);
  assert.strictEqual(body.data[0].from, "A");
  assert.strictEqual(body.data[0].dest, "qubic");
  assert.strictEqual(body.data[0].status, "in-progress");
});

test("GET /api/orders handles repository errors", async (t) => {
  const app = await build(t);
  const { mock: repoMock } = t.mock.method(app.ordersRepository, "paginate");
  repoMock.mockImplementation(() => {
    throw new Error("db down");
  });

  const { mock: logMock } = t.mock.method(app.log, "error");

  const res = await app.inject({
    url: "/api/orders",
    method: "GET",
  });

  assert.strictEqual(res.statusCode, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logPayload, logMsg] = logMock.calls[0].arguments as any;
  assert.strictEqual(logMsg, "Failed to list orders");
  assert.strictEqual(logPayload.err.message, "db down");

  const body = JSON.parse(res.payload);
  assert.strictEqual(body.message, "Internal Server Error");
});
