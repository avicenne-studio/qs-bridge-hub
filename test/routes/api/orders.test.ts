import { test, TestContext } from "node:test";
import { build } from "../../helper.js";

async function seedOrders(app: Awaited<ReturnType<typeof build>>) {
  await app.ordersRepository.create({
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: 10,
    is_relayable: false,
    status: "in-progress",
  });
  await app.ordersRepository.create({
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: 25,
    is_relayable: false,
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
  t.assert.strictEqual(body.data[0].is_relayable, false);
});

test("GET /api/orders/signatures returns stored signatures", async (t: TestContext) => {
  const app = await build(t);

  const first = await app.ordersRepository.create({
    source: "solana",
    dest: "qubic",
    from: "A",
    to: "B",
    amount: 10,
    is_relayable: false,
    status: "pending",
  });
  const second = await app.ordersRepository.create({
    source: "qubic",
    dest: "solana",
    from: "C",
    to: "D",
    amount: 20,
    is_relayable: false,
    status: "in-progress",
  });
  await app.ordersRepository.create({
    source: "qubic",
    dest: "solana",
    from: "E",
    to: "F",
    amount: 30,
    is_relayable: false,
    status: "finalized",
  });

  await app.ordersRepository.addSignatures(first!.id, ["sigA", "sigB"]);
  await app.ordersRepository.addSignatures(second!.id, ["sigC"]);

  const res = await app.inject({
    url: "/api/orders/signatures",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.data.length, 2);

  const byId = new Map(body.data.map((order: { id: number; signatures: { signature: string }[] }) => [
    order.id,
    order.signatures.map((entry) => entry.signature).sort(),
  ]));

  t.assert.deepStrictEqual(byId.get(first!.id), ["sigA", "sigB"]);
  t.assert.deepStrictEqual(byId.get(second!.id), ["sigC"]);
});

test("GET /api/orders handles repository errors", async (t: TestContext) => {
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

  t.assert.strictEqual(res.statusCode, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logPayload, logMsg] = logMock.calls[0].arguments as any;
  t.assert.strictEqual(logMsg, "Failed to list orders");
  t.assert.strictEqual(logPayload.err.message, "db down");

  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Internal Server Error");
});
