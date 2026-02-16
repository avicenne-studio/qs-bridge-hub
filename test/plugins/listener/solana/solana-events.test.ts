import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSolanaEventHandlers } from "../../../../src/plugins/app/events/solana/solana-events.js";

const NONCE = (n: number) => {
  const arr = new Uint8Array(32);
  arr[31] = n;
  return arr;
};
const BYTES32 = (fill: number) => new Uint8Array(32).fill(fill);

function createOutboundEvent() {
  return {
    discriminator: 1,
    networkIn: 1,
    networkOut: 2,
    tokenIn: BYTES32(1),
    tokenOut: BYTES32(2),
    fromAddress: BYTES32(3),
    toAddress: BYTES32(4),
    amount: 10n,
    relayerFee: 2n,
    nonce: NONCE(1),
  };
}

function createOverrideEvent() {
  return {
    discriminator: 2,
    toAddress: BYTES32(9),
    relayerFee: 7n,
    nonce: NONCE(2),
  };
}

function createInboundEvent() {
  return {
    discriminator: 0,
    networkIn: 1,
    networkOut: 2,
    tokenIn: BYTES32(1),
    tokenOut: BYTES32(2),
    fromAddress: BYTES32(3),
    toAddress: BYTES32(4),
    amount: 10n,
    relayerFee: 2n,
    nonce: NONCE(3),
  };
}

function createTestHandlers(stored: { type: string; signature: string; slot?: number | null }[] = []) {
  const eventsRepository = {
    async create(event: { type: string; signature: string; slot?: number | null }) {
      stored.push(event);
      return {
        id: stored.length,
        ...event,
        slot: event.slot ?? null,
        chain: "solana",
        nonce: "0".repeat(64),
        payload: {},
        createdAt: new Date().toISOString(),
      };
    },
  };
  const logger = { info: () => {}, warn: () => {} };
  const handlers = createSolanaEventHandlers({
    eventsRepository: eventsRepository as never,
    logger: logger as never,
  });
  return { handlers, stored };
}

describe("solana event handlers", () => {
  it("stores outbound, override-outbound and inbound with signature", async () => {
    const stored: { type: string; signature: string; slot?: number | null }[] = [];
    const { handlers } = createTestHandlers(stored);

    await handlers.handleOutboundEvent(createOutboundEvent(), { signature: "sig-out", slot: 10 });
    await handlers.handleOverrideOutboundEvent(createOverrideEvent(), { signature: "sig-override" });
    await handlers.handleInboundEvent(createInboundEvent(), { signature: "sig-inbound" });

    assert.strictEqual(stored.length, 3);
    assert.strictEqual(stored[0].type, "outbound");
    assert.strictEqual(stored[0].signature, "sig-out");
    assert.strictEqual(stored[1].type, "override-outbound");
    assert.strictEqual(stored[1].signature, "sig-override");
    assert.strictEqual(stored[2].type, "inbound");
    assert.strictEqual(stored[2].signature, "sig-inbound");
    assert.strictEqual(stored[2].slot, null);
  });

  it("skips and warns when signature missing (any handler)", async () => {
    const stored: { type: string }[] = [];
    const warnCalls: unknown[][] = [];
    const eventsRepository = {
      async create(event: { type: string }) {
        stored.push(event);
        return { id: 1, ...event, signature: "", slot: null, chain: "solana", nonce: "", payload: {}, createdAt: "" };
      },
    };
    const handlers = createSolanaEventHandlers({
      eventsRepository: eventsRepository as never,
      logger: { info: () => {}, warn: (...args: unknown[]) => warnCalls.push(args) } as never,
    });

    await handlers.handleOutboundEvent(createOutboundEvent(), {});
    await handlers.handleOverrideOutboundEvent(createOverrideEvent(), {});
    await handlers.handleInboundEvent(createInboundEvent(), {});

    assert.strictEqual(stored.length, 0);
    assert.strictEqual(warnCalls.length, 3);
  });
});
