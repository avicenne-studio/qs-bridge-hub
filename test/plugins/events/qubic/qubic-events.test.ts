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
  it("stores a lock event using orderHash as signature", async (t: TestContext) => {
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
      orderHash: "deadbeef01",
      payload: {
        fromAddress: "aa".repeat(32),
        toAddress: "SolAddr",
        amount: "10",
        relayerFee: "1",
        nonce: "2",
        orderEra: "0",
      },
    });

    t.assert.strictEqual(eventsRepository.store.length, 1);
    t.assert.strictEqual(eventsRepository.store[0].signature, "deadbeef01");
  });

  it("stores an unlock event using orderHash as signature", async (t: TestContext) => {
    const { logger } = createLogger();
    const eventsRepository = createEventsRepository();
    const { handleQubicEvent } = createQubicEventHandlers({
      eventsRepository: eventsRepository as never,
      logger: logger as never,
    });

    await handleQubicEvent({
      chain: "qubic",
      type: "unlock",
      nonce: "3",
      orderHash: "cafebabe03",
      payload: {
        toAddress: "SolAddr",
        amount: "99",
        nonce: "3",
      },
    });

    t.assert.strictEqual(eventsRepository.store.length, 1);
    t.assert.strictEqual(eventsRepository.store[0].signature, "cafebabe03");
  });
});
