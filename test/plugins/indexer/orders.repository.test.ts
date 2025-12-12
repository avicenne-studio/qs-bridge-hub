import { it, describe } from "node:test";
import assert from "node:assert";
import { build } from "../../helper.js";
import { ORDERS_TABLE_NAME } from "../../../src/plugins/app/indexer/orders.repository.js";

describe("ordersRepository", () => {
  it("should create and retrieve an order by id", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const hasTable = await app.knex.schema.hasTable(ORDERS_TABLE_NAME);

    console.log("rhas table test", hasTable);

    const created = await repo.create({
      source: "solana",
      dest: "qubic",
      from: "Alice",
      to: "Bob",
      amount: 123,
    });

    assert.ok(created);
    assert.strictEqual(created?.id, 1);
    assert.strictEqual(created?.source, "solana");
    assert.strictEqual(created?.dest, "qubic");
    assert.strictEqual(created?.from, "Alice");
    assert.strictEqual(created?.to, "Bob");
    assert.strictEqual(created?.amount, 123);

    const fetched = await repo.findById(created!.id);
    assert.deepStrictEqual(fetched, created);
  });

  it("should paginate orders", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;
    const empty = await repo.paginate({
      page: 1,
      limit: 2,
      order: "asc",
    });

    assert.strictEqual(empty.orders.length, 0);
    assert.strictEqual(empty.total, 0);

    // Insert 3 orders
    await repo.create({
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 10,
    });
    await repo.create({
      source: "solana",
      dest: "qubic",
      from: "C",
      to: "D",
      amount: 20,
    });
    await repo.create({
      source: "qubic",
      dest: "solana",
      from: "E",
      to: "F",
      amount: 30,
    });

    const page1 = await repo.paginate({
      page: 1,
      limit: 2,
      order: "asc",
    });

    assert.strictEqual(page1.orders.length, 2);
    assert.strictEqual(page1.total, 3);
    assert.strictEqual(page1.orders[0].id, 1);
    assert.strictEqual(page1.orders[1].id, 2);

    const page2 = await repo.paginate({
      page: 2,
      limit: 2,
      order: "asc",
    });

    assert.strictEqual(page2.orders.length, 1);
    assert.strictEqual(page2.orders[0].id, 3);
  });

  it("should filter by source or dest", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    await repo.create({
      source: "solana",
      dest: "qubic",
      from: "X",
      to: "Y",
      amount: 1,
    });
    await repo.create({
      source: "qubic",
      dest: "solana",
      from: "Z",
      to: "T",
      amount: 2,
    });

    const solToQubic = await repo.paginate({
      page: 1,
      limit: 10,
      order: "asc",
      source: "solana",
    });

    assert.strictEqual(solToQubic.orders.length, 1);
    assert.strictEqual(solToQubic.orders[0].source, "solana");
    assert.strictEqual(solToQubic.orders[0].dest, "qubic");

    const qubicToSol = await repo.paginate({
      page: 1,
      limit: 10,
      order: "asc",
      dest: "solana",
    });

    assert.strictEqual(qubicToSol.orders.length, 1);
    assert.strictEqual(qubicToSol.orders[0].source, "qubic");
    assert.strictEqual(qubicToSol.orders[0].dest, "solana");
  });

  it("should update an order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 50,
    });

    const updated = await repo.update(created!.id, { amount: 42 });

    assert.ok(updated);
    assert.strictEqual(updated?.amount, 42);

    const fetched = await repo.findById(created!.id);
    assert.strictEqual(fetched?.amount, 42);
  });

  it("should return null when updating a non-existent order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const updated = await repo.update(9999, { amount: 100 });
    assert.strictEqual(updated, null);
  });

  it("should delete an order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      source: "solana",
      dest: "qubic",
      from: "DeleteA",
      to: "DeleteB",
      amount: 7,
    });

    const removed = await repo.delete(created!.id);
    assert.strictEqual(removed, true);

    const after = await repo.findById(created!.id);
    assert.strictEqual(after, null);
  });

  it("should return false when deleting a non-existent order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const removed = await repo.delete(9999);
    assert.strictEqual(removed, false);
  });
});
