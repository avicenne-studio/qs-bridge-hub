import { describe, it, TestContext } from "node:test";
import { createQubicEventHandlers } from "../../../../src/plugins/app/events/qubic/qubic-events.js";

function createLogger() {
  const entries: Array<{ message: string }> = [];
  return {
    entries,
    logger: {
      info: (_payload: unknown, message?: string) => {
        entries.push({ message: message ?? "" });
      },
      warn: (message: string) => {
        entries.push({ message });
      },
    },
  };
}

function createEventsRepository() {
  const store: Array<{ signature: string }> = [];
  return {
    store,
    async create(event: { signature: string }) {
      store.push({ signature: event.signature });
      return event;
    },
  };
}

describe("qubic event handlers", () => {
  it("warns when missing transaction hash", async (t: TestContext) => {
    const { logger, entries } = createLogger();
    const eventsRepository = createEventsRepository();
    const { handleQubicEvent } = createQubicEventHandlers({
      eventsRepository: eventsRepository as never,
      logger: logger as never,
    });

    await handleQubicEvent({
      chain: "qubic",
      type: "lock",
      nonce: "1",
      payload: {
        fromAddress: "id(1,2,3,4)",
        toAddress: "id(4,3,2,1)",
        amount: "10",
        relayerFee: "1",
        nonce: "1",
      },
    });

    t.assert.strictEqual(eventsRepository.store.length, 0);
    t.assert.ok(entries.some((entry) => entry.message.includes("missing transaction hash")));
  });

  it("stores qubic events", async (t: TestContext) => {
    const { logger } = createLogger();
    const eventsRepository = createEventsRepository();
    const { handleQubicEvent } = createQubicEventHandlers({
      eventsRepository: eventsRepository as never,
      logger: logger as never,
    });

    await handleQubicEvent({
      chain: "qubic",
      type: "lock",
      nonce: "2",
      trxHash: "trx-2",
      payload: {
        fromAddress: "id(1,2,3,4)",
        toAddress: "id(4,3,2,1)",
        amount: "10",
        relayerFee: "1",
        nonce: "2",
      },
    });

    t.assert.strictEqual(eventsRepository.store.length, 1);
    t.assert.strictEqual(eventsRepository.store[0].signature, "trx-2");
  });
});
