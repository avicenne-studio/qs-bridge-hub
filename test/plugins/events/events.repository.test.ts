import { it, describe, TestContext } from "node:test";
import { build } from "../../helpers/build.js";
import {
  kEventsRepository,
  type EventsRepository,
} from "../../../src/plugins/app/events/events.repository.js";

const hex32 = (value: number) => value.toString(16).padStart(64, "0");

function createOutboundPayload(seed: number) {
  return {
    networkIn: 1,
    networkOut: 2,
    tokenIn: hex32(seed),
    tokenOut: hex32(seed + 1),
    fromAddress: hex32(seed + 2),
    toAddress: hex32(seed + 3),
    amount: "10",
    relayerFee: "2",
    nonce: hex32(seed + 4),
  };
}

describe("eventsRepository", () => {
  it("creates and lists events", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.getDecorator<EventsRepository>(kEventsRepository);

    const created = await repo.create({
      signature: "sig-1",
      slot: 42,
      chain: "solana",
      type: "outbound",
      nonce: hex32(99),
      payload: createOutboundPayload(1),
    });

    t.assert.ok(created);
    t.assert.strictEqual(created?.signature, "sig-1");
    t.assert.strictEqual(created?.slot, 42);
    t.assert.strictEqual(created?.type, "outbound");
    t.assert.strictEqual(created?.payload.amount, "10");

    const listed = await repo.listAfterCreatedAt("1970-01-01 00:00:00", 0, 10);
    t.assert.strictEqual(listed.length, 1);
    t.assert.strictEqual(listed[0].id, created!.id);
  });

  it("ignores duplicate events by signature/type/nonce", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.getDecorator<EventsRepository>(kEventsRepository);

    const first = await repo.create({
      signature: "sig-dup",
      slot: 1,
      chain: "solana",
      type: "outbound",
      nonce: hex32(5),
      payload: createOutboundPayload(2),
    });
    const second = await repo.create({
      signature: "sig-dup",
      slot: 2,
      chain: "solana",
      type: "outbound",
      nonce: hex32(5),
      payload: createOutboundPayload(3),
    });

    t.assert.ok(first);
    t.assert.strictEqual(second, null);
    const listed = await repo.listAfterCreatedAt("1970-01-01 00:00:00", 0, 10);
    t.assert.strictEqual(listed.length, 1);
  });

  it("paginates with after cursor", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.getDecorator<EventsRepository>(kEventsRepository);

    await repo.create({
      signature: "sig-a",
      slot: 1,
      chain: "solana",
      type: "outbound",
      nonce: hex32(10),
      payload: createOutboundPayload(10),
    });
    await repo.create({
      signature: "sig-b",
      slot: 2,
      chain: "solana",
      type: "override-outbound",
      nonce: hex32(11),
      payload: {
        toAddress: hex32(12),
        relayerFee: "3",
        nonce: hex32(11),
      },
    });

    const firstPage = await repo.listAfterCreatedAt(
      "1970-01-01 00:00:00",
      0,
      1
    );
    t.assert.strictEqual(firstPage.length, 1);
    const secondPage = await repo.listAfterCreatedAt(
      firstPage[0].createdAt,
      firstPage[0].id,
      10
    );
    t.assert.strictEqual(secondPage.length, 1);
  });

  it("normalizes null slots to undefined", async (t: TestContext) => {
    const app = await build(t);
    const repo = app.getDecorator<EventsRepository>(kEventsRepository);

    await repo.create({
      signature: "sig-null-slot",
      slot: null,
      chain: "solana",
      type: "outbound",
      nonce: hex32(20),
      payload: createOutboundPayload(20),
    });

    const listed = await repo.listAfterCreatedAt("1970-01-01 00:00:00", 0, 10);
    t.assert.strictEqual(listed[0].slot, undefined);
  });

  describe("findExistingSignatures", () => {
    it("returns empty array when input is empty", async (t: TestContext) => {
      const app = await build(t);
      const repo = app.getDecorator<EventsRepository>(kEventsRepository);

      const result = await repo.findExistingSignatures([]);
      t.assert.deepStrictEqual(result, []);
    });

    it("returns matching signatures from database", async (t: TestContext) => {
      const app = await build(t);
      const repo = app.getDecorator<EventsRepository>(kEventsRepository);

      await repo.create({
        signature: "sig-exists-1",
        slot: 1,
        chain: "solana",
        type: "outbound",
        nonce: hex32(30),
        payload: createOutboundPayload(30),
      });
      await repo.create({
        signature: "sig-exists-2",
        slot: 2,
        chain: "solana",
        type: "outbound",
        nonce: hex32(31),
        payload: createOutboundPayload(31),
      });

      const result = await repo.findExistingSignatures([
        "sig-exists-1",
        "sig-not-found",
        "sig-exists-2",
      ]);

      t.assert.strictEqual(result.length, 2);
      t.assert.ok(result.includes("sig-exists-1"));
      t.assert.ok(result.includes("sig-exists-2"));
    });

    it("returns empty array when no signatures match", async (t: TestContext) => {
      const app = await build(t);
      const repo = app.getDecorator<EventsRepository>(kEventsRepository);

      const result = await repo.findExistingSignatures(["sig-unknown-1", "sig-unknown-2"]);
      t.assert.deepStrictEqual(result, []);
    });
  });
});
