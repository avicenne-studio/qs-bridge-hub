import { describe, it, TestContext } from "node:test";
import { Buffer } from "node:buffer";
import {
  createDefaultQubicEventFetcher,
  type QubicEvent,
  kQubicEventFetcher,
} from "../../../../src/plugins/app/listener/qubic/qubic-event-poller.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import {
  type LockedOrder,
  type QubicContractClient,
} from "../../../../src/plugins/infra/qubic-contract-client.js";
import { createInMemoryEventsRepository } from "../../../helpers/solana-events.js";
import { waitFor } from "../../../helpers/wait-for.js";
import { build } from "../../../helpers/build.js";
import { mockLogMethod } from "../../../helpers/mocks/logger.js";

function uint8(fill: number, size: number) {
  return new Uint8Array(size).fill(fill);
}

function asciiBytes(value: string, size: number) {
  const buf = Buffer.alloc(size);
  buf.write(value, 0, "ascii");
  return new Uint8Array(buf);
}

function createLockedOrder(opts: {
  senderFill?: number;
  amount?: bigint;
  relayerFee?: bigint;
  nonce: number;
  toAddress?: string;
  orderHashFill: number;
  orderEra?: number;
  active?: boolean;
}): LockedOrder {
  return {
    sender: uint8(opts.senderFill ?? 0xaa, 32),
    amount: opts.amount ?? 1000n,
    relayerFee: opts.relayerFee ?? 10n,
    networkOut: 2,
    nonce: opts.nonce,
    toAddress: asciiBytes(opts.toAddress ?? "SolAddr", 64),
    orderHash: uint8(opts.orderHashFill, 32),
    lockEpoch: 100,
    orderEra: opts.orderEra ?? 0,
    active: opts.active ?? true,
  };
}

function createStateClient(states: Array<{ locks?: LockedOrder[]; filled?: Uint8Array[] }>): QubicContractClient {
  let round = 0;
  const current = () => states[Math.min(round, states.length - 1)] ?? {};
  const advance = () => {
    round += 1;
  };
  return {
    async queryContractFunction() {
      throw new Error("not used in this test");
    },
    async getBobStatus() {
      return { epoch: 0, tick: 0 };
    },
    async getLockedOrders() {
      const locks = current().locks ?? [];
      return { totalActive: locks.length, returned: locks.length, entries: locks };
    },
    async getFilledOrders() {
      const filled = current().filled ?? [];
      return { totalActive: filled.length, returned: filled.length, hashes: filled };
    },
    async listLockedOrders() {
      return current().locks ?? [];
    },
    async listFilledOrderHashes() {
      const filled = current().filled ?? [];
      advance();
      return filled;
    },
  };
}

const BASE_CONFIG = {
  QUBIC_POLLER_ENABLED: true,
  QUBIC_POLLER_INTERVAL_MS: 10,
  QUBIC_POLLER_TIMEOUT_MS: 1000,
  QUBIC_POLLER_SYNC_TO_HEAD_ON_START: false,
  ORACLE_URLS: "",
};

async function buildApp(
  t: TestContext,
  fetcher: () => Promise<QubicEvent[]>,
  eventsRepo = createInMemoryEventsRepository(),
  opts: {
    enabled?: boolean;
    config?: Partial<typeof BASE_CONFIG>;
  } = {},
) {
  const app = await build(t, {
    useMocks: false,
    config: {
      ...BASE_CONFIG,
      ...opts.config,
      QUBIC_POLLER_ENABLED: opts.enabled ?? BASE_CONFIG.QUBIC_POLLER_ENABLED,
    },
    decorators: {
      [kEventsRepository]: eventsRepo,
      [kQubicEventFetcher]: fetcher,
    },
  });

  return { app, eventsRepo };
}

describe("qubic poller plugin", () => {
  it("stores lock event decoded from smart contract state", async (t: TestContext) => {
    const order = createLockedOrder({ nonce: 1, orderHashFill: 0xab });
    const fetcher = createDefaultQubicEventFetcher(
      createStateClient([{ locks: [order], filled: [] }]),
    );
    const { eventsRepo } = await buildApp(t, fetcher);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, Buffer.from(order.orderHash).toString("hex"));
    t.assert.strictEqual(eventsRepo.store[0].chain, "qubic");
    t.assert.strictEqual(eventsRepo.store[0].type, "lock");
    t.assert.strictEqual(eventsRepo.store[0].nonce, "1");
  });

  it("synchronizes to current smart contract state on startup without replaying historical locks", async (t: TestContext) => {
    const historicalOrder = createLockedOrder({ nonce: 30, orderHashFill: 0x91 });
    const liveOrder = createLockedOrder({ nonce: 31, orderHashFill: 0x92 });
    const fetcher = createDefaultQubicEventFetcher(
      createStateClient([
        { locks: [historicalOrder], filled: [] },
        { locks: [historicalOrder, liveOrder], filled: [] },
      ]),
      { syncToHeadOnStart: true },
    );

    const { eventsRepo } = await buildApp(t, fetcher, undefined, {
      config: { QUBIC_POLLER_SYNC_TO_HEAD_ON_START: true },
    });

    await waitFor(() => eventsRepo.store.some((e) => e.nonce === "31"));

    t.assert.strictEqual(eventsRepo.store.some((e) => e.nonce === "30"), false);
    t.assert.strictEqual(eventsRepo.store.some((e) => e.nonce === "31"), true);
  });

  it("detects override-lock when the same sender nonce is replaced by a new order hash", async (t: TestContext) => {
    const first = createLockedOrder({
      nonce: 2,
      orderHashFill: 0xa1,
      toAddress: "SolAddrA",
      relayerFee: 1n,
    });
    const overridden = createLockedOrder({
      nonce: 2,
      orderHashFill: 0xa2,
      toAddress: "SolAddrB",
      relayerFee: 5n,
    });
    const fetcher = createDefaultQubicEventFetcher(
      createStateClient([
        { locks: [first], filled: [] },
        { locks: [overridden], filled: [] },
      ]),
    );
    const { eventsRepo } = await buildApp(t, fetcher);

    await waitFor(() =>
      eventsRepo.store.some(
        (e) =>
          e.type === "override-lock" &&
          e.signature === Buffer.from(overridden.orderHash).toString("hex"),
      ),
    );

    const overrideEvent = eventsRepo.store.find((e) => e.type === "override-lock")!;
    t.assert.strictEqual(overrideEvent.nonce, "2");
  });

  it("stores unlock event from filled order hashes", async (t: TestContext) => {
    const orderHash = uint8(0xfa, 32);
    const fetcher = createDefaultQubicEventFetcher(
      createStateClient([
        { locks: [], filled: [] },
        { locks: [], filled: [orderHash] },
      ]),
    );
    const { eventsRepo } = await buildApp(t, fetcher);

    await waitFor(() => eventsRepo.store.some((e) => e.type === "unlock"));

    const unlockEvent = eventsRepo.store.find((e) => e.type === "unlock")!;
    t.assert.strictEqual(unlockEvent.signature, Buffer.from(orderHash).toString("hex"));
    t.assert.strictEqual(unlockEvent.nonce, "");
    t.assert.deepStrictEqual(unlockEvent.payload, {
      toAddress: "0".repeat(64),
      amount: "0",
      nonce: "",
    });
  });

  it("does not duplicate lock events across multiple rounds", async (t: TestContext) => {
    const order = createLockedOrder({ nonce: 4, orderHashFill: 0xdd });
    const signature = Buffer.from(order.orderHash).toString("hex");
    const fetcher = createDefaultQubicEventFetcher(
      createStateClient([
        { locks: [order], filled: [] },
        { locks: [order], filled: [] },
        { locks: [order], filled: [] },
      ]),
    );
    const { eventsRepo } = await buildApp(t, fetcher);

    await waitFor(() => eventsRepo.store.length >= 1);
    await waitFor(() => eventsRepo.store.filter((e) => e.signature === signature).length === 1);

    const matches = eventsRepo.store.filter((e) => e.signature === signature);
    t.assert.strictEqual(matches.length, 1);
  });

  it("does not duplicate unlock events across multiple rounds", async (t: TestContext) => {
    const orderHash = uint8(0xfc, 32);
    const signature = Buffer.from(orderHash).toString("hex");
    const fetcher = createDefaultQubicEventFetcher(
      createStateClient([
        { locks: [], filled: [orderHash] },
        { locks: [], filled: [orderHash] },
        { locks: [], filled: [orderHash] },
      ]),
    );
    const { eventsRepo } = await buildApp(t, fetcher);

    await waitFor(() => eventsRepo.store.length >= 1);
    await waitFor(() => eventsRepo.store.filter((e) => e.signature === signature).length === 1);

    const unlockEvents = eventsRepo.store.filter((e) => e.type === "unlock");
    t.assert.strictEqual(unlockEvents.length, 1);
  });

  it("does nothing when QUBIC_POLLER_ENABLED is false", async (t: TestContext) => {
    let callCount = 0;
    await buildApp(
      t,
      async () => {
        callCount++;
        return [];
      },
      undefined,
      { enabled: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(callCount, 0);
  });

  it("logs when fetcher throws and keeps running", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    const { app } = await buildApp(
      t,
      async () => {
        throw new Error("boom");
      },
      eventsRepo,
    );

    const warnMock = mockLogMethod(t, app.log, "warn");

    await waitFor(() =>
      warnMock.calls.some(
        (call: { arguments: unknown[] }) => call.arguments[1] === "qubic events poll failed",
      ),
    );

    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("uses custom fetcher when decorated", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    const customEvent: QubicEvent = {
      chain: "qubic",
      type: "lock",
      nonce: "5",
      orderHash: "ee".repeat(32),
      payload: {
        fromAddress: "00".repeat(32),
        toAddress: "SolAddr",
        amount: "100",
        relayerFee: "1",
        nonce: "5",
        orderEra: "0",
      },
    };

    await buildApp(t, async () => [customEvent], eventsRepo);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, customEvent.orderHash);
  });
});
