import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOutboundEventCodec } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventCodec } from "../../../../src/clients/js/types/overrideOutboundEvent.js";

describe("solana event codecs", () => {
  it("encodes and decodes outbound events", () => {
    const codec = getOutboundEventCodec();
    const bytes = codec.encode({
      networkIn: 1,
      networkOut: 2,
      tokenIn: new Uint8Array(32).fill(1),
      tokenOut: new Uint8Array(32).fill(2),
      fromAddress: new Uint8Array(32).fill(3),
      toAddress: new Uint8Array(32).fill(4),
      amount: 10n,
      relayerFee: 2n,
      nonce: new Uint8Array(32).fill(5),
    });
    const decoded = codec.decode(bytes);
    assert.strictEqual(decoded.networkIn, 1);
    assert.strictEqual(decoded.networkOut, 2);
    assert.strictEqual(decoded.relayerFee, 2n);
  });

  it("encodes and decodes override outbound events", () => {
    const codec = getOverrideOutboundEventCodec();
    const bytes = codec.encode({
      toAddress: new Uint8Array(32).fill(9),
      relayerFee: 7n,
      nonce: new Uint8Array(32).fill(8),
    });
    const decoded = codec.decode(bytes);
    assert.strictEqual(decoded.relayerFee, 7n);
  });
});
