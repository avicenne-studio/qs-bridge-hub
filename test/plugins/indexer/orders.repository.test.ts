import { it, describe, TestContext } from "node:test";
import { build } from "../../helper.js";

describe("ordersRepository", () => {
  it("should create and retrieve an order by id", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 101,
      source: "solana",
      dest: "qubic",
      from: "Alice",
      to: "Bob",
      amount: 123,
      is_relayable: false,
      status: "in-progress",
    });

    t.assert.ok(created);
    t.assert.strictEqual(created?.id, 101);
    t.assert.strictEqual(created?.source, "solana");
    t.assert.strictEqual(created?.dest, "qubic");
    t.assert.strictEqual(created?.from, "Alice");
    t.assert.strictEqual(created?.to, "Bob");
    t.assert.strictEqual(created?.amount, 123);
    t.assert.strictEqual(created?.is_relayable, false);
    t.assert.strictEqual(created?.status, "in-progress");

    const fetched = await repo.findById(created!.id);
    t.assert.deepStrictEqual(fetched, created);
  });

  it("should paginate orders", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;
    const empty = await repo.paginate({
      page: 1,
      limit: 2,
      order: "asc",
    });

    t.assert.strictEqual(empty.orders.length, 0);
    t.assert.strictEqual(empty.total, 0);

    // Insert 3 orders
    await repo.create({
      id: 10,
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 10,
      is_relayable: false,
      status: "in-progress",
    });
    await repo.create({
      id: 20,
      source: "solana",
      dest: "qubic",
      from: "C",
      to: "D",
      amount: 20,
      is_relayable: false,
      status: "finalized",
    });
    await repo.create({
      id: 30,
      source: "qubic",
      dest: "solana",
      from: "E",
      to: "F",
      amount: 30,
      is_relayable: false,
      status: "in-progress",
    });

    const page1 = await repo.paginate({
      page: 1,
      limit: 2,
      order: "asc",
    });

    t.assert.strictEqual(page1.orders.length, 2);
    t.assert.strictEqual(page1.total, 3);
    t.assert.strictEqual(page1.orders[0].id, 10);
    t.assert.strictEqual(page1.orders[1].id, 20);

    const page2 = await repo.paginate({
      page: 2,
      limit: 2,
      order: "asc",
    });

    t.assert.strictEqual(page2.orders.length, 1);
    t.assert.strictEqual(page2.orders[0].id, 30);
  });

  it("should filter by source or dest", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    await repo.create({
      id: 11,
      source: "solana",
      dest: "qubic",
      from: "X",
      to: "Y",
      amount: 1,
      is_relayable: false,
      status: "in-progress",
    });
    await repo.create({
      id: 12,
      source: "qubic",
      dest: "solana",
      from: "Z",
      to: "T",
      amount: 2,
      is_relayable: false,
      status: "finalized",
    });

    const solToQubic = await repo.paginate({
      page: 1,
      limit: 10,
      order: "asc",
      source: "solana",
    });

    t.assert.strictEqual(solToQubic.orders.length, 1);
    t.assert.strictEqual(solToQubic.orders[0].source, "solana");
    t.assert.strictEqual(solToQubic.orders[0].dest, "qubic");

    const qubicToSol = await repo.paginate({
      page: 1,
      limit: 10,
      order: "asc",
      dest: "solana",
    });

    t.assert.strictEqual(qubicToSol.orders.length, 1);
    t.assert.strictEqual(qubicToSol.orders[0].source, "qubic");
    t.assert.strictEqual(qubicToSol.orders[0].dest, "solana");
  });

  it("should update an order", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 44,
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 50,
      is_relayable: false,
      status: "in-progress",
    });

    const updated = await repo.update(created!.id, {
      amount: 42,
      status: "finalized",
    });

    t.assert.ok(updated);
    t.assert.strictEqual(updated?.amount, 42);
    t.assert.strictEqual(updated?.status, "finalized");

    const fetched = await repo.findById(created!.id);
    t.assert.strictEqual(fetched?.amount, 42);
    t.assert.strictEqual(fetched?.status, "finalized");
  });

  it(
    "should return null when updating a non-existent order",
    async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const updated = await repo.update(9999, { amount: 100 });
      t.assert.strictEqual(updated, null);
    }
  );

  it("should delete an order", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 55,
      source: "solana",
      dest: "qubic",
      from: "DeleteA",
      to: "DeleteB",
      amount: 7,
      is_relayable: false,
      status: "finalized",
    });

    const removed = await repo.delete(created!.id);
    t.assert.strictEqual(removed, true);

    const after = await repo.findById(created!.id);
    t.assert.strictEqual(after, null);
  });

  it(
    "should return false when deleting a non-existent order",
    async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const removed = await repo.delete(9999);
      t.assert.strictEqual(removed, false);
    }
  );

  it("should return empty list when fetching signatures without orders", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const orders = await repo.findByIdsWithSignatures([]);
    t.assert.deepStrictEqual(orders, []);
  });

  it("should return empty list when ids do not exist", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const orders = await repo.findByIdsWithSignatures([123]);
    t.assert.deepStrictEqual(orders, []);
  });

  it("should add signatures without duplicates", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 77,
      source: "solana",
      dest: "qubic",
      from: "SigA",
      to: "SigB",
      amount: 5,
      is_relayable: false,
      status: "in-progress",
    });

    const firstInsert = await repo.addSignatures(created!.id, ["sigA", "sigB"]);
    t.assert.deepStrictEqual(firstInsert, ["sigA", "sigB"]);

    const skipped = await repo.addSignatures(created!.id, []);
    t.assert.deepStrictEqual(skipped, []);

    const secondInsert = await repo.addSignatures(created!.id, ["sigA", "sigC"]);
    t.assert.deepStrictEqual(secondInsert, ["sigC"]);

    const duplicatesOnly = await repo.addSignatures(created!.id, ["sigA"]);
    t.assert.deepStrictEqual(duplicatesOnly, []);

    const orders = await repo.findByIdsWithSignatures([created!.id]);
    t.assert.strictEqual(orders.length, 1);
    t.assert.strictEqual(orders[0].signatures.length, 3);
    t.assert.strictEqual(orders[0].signatures[0].order_id, created!.id);
  });

  it("should return empty signatures for orders without signatures", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 78,
      source: "solana",
      dest: "qubic",
      from: "NoSigA",
      to: "NoSigB",
      amount: 9,
      is_relayable: false,
      status: "in-progress",
    });

    const orders = await repo.findByIdsWithSignatures([created!.id]);
    t.assert.strictEqual(orders.length, 1);
    t.assert.deepStrictEqual(orders[0].signatures, []);
  });

  it("should return active ids with limit", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const pending = await repo.create({
      id: 90,
      source: "solana",
      dest: "qubic",
      from: "P",
      to: "Q",
      amount: 1,
      is_relayable: false,
      status: "pending",
    });
    const inProgress = await repo.create({
      id: 91,
      source: "solana",
      dest: "qubic",
      from: "R",
      to: "S",
      amount: 2,
      is_relayable: false,
      status: "in-progress",
    });
    await repo.create({
      id: 92,
      source: "solana",
      dest: "qubic",
      from: "T",
      to: "U",
      amount: 3,
      is_relayable: false,
      status: "ready-for-relay",
    });

    const activeIds = await repo.findActivesIds();
    t.assert.deepStrictEqual(activeIds, [pending!.id, inProgress!.id]);

    const limited = await repo.findActivesIds(1);
    t.assert.deepStrictEqual(limited, [pending!.id]);
  });
});
