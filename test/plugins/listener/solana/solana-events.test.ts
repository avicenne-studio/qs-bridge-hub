import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSolanaEventHandlers } from "../../../../src/plugins/app/listener/solana/solana-events.js";

function createOutboundEvent() {
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return {
    networkIn: 1,
    networkOut: 2,
    tokenIn: new Uint8Array(32).fill(1),
    tokenOut: new Uint8Array(32).fill(2),
    fromAddress: new Uint8Array(32).fill(3),
    toAddress: new Uint8Array(32).fill(4),
    amount: 10n,
    relayerFee: 2n,
    nonce,
  };
}

function createOverrideEvent() {
  const nonce = new Uint8Array(32);
  nonce[31] = 2;
  return {
    toAddress: new Uint8Array(32).fill(9),
    relayerFee: 7n,
    nonce,
  };
}

describe("solana event handlers", () => {
  it("stores outbound and override events", async () => {
    const stored: Array<{ type: string; signature: string }> = [];
    const eventsRepository = {
      async create(event: { type: string; signature: string }) {
        stored.push(event);
        return {
          id: stored.length,
          ...event,
          slot: null,
          chain: "solana",
          nonce: "0".repeat(64),
          payload: {},
          createdAt: new Date().toISOString(),
        };
      },
    };
    const logger = {
      info: () => {},
      warn: () => {},
    };
    const handlers = createSolanaEventHandlers({
      eventsRepository: eventsRepository as never,
      logger: logger as never,
    });

    await handlers.handleOutboundEvent(createOutboundEvent(), {
      signature: "sig-out",
      slot: 10,
    });
    await handlers.handleOverrideOutboundEvent(createOverrideEvent(), {
      signature: "sig-override",
    });
    await handlers.handleOverrideOutboundEvent(createOverrideEvent(), {
      signature: "sig-override-noslot",
    });

    assert.strictEqual(stored.length, 3);
    assert.strictEqual(stored[0].signature, "sig-out");
    assert.strictEqual(stored[1].signature, "sig-override");
    assert.strictEqual(stored[2].signature, "sig-override-noslot");
  });
});
