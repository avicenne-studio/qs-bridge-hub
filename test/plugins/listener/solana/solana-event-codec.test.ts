import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOutboundEventCodec } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventCodec } from "../../../../src/clients/js/types/overrideOutboundEvent.js";
import { BYTES32 } from "../../../helpers/solana-events.js";

describe("solana event codecs", () => {
  it("encodes and decodes outbound events", () => {
    const codec = getOutboundEventCodec();
    const bytes = codec.encode({
      networkIn: 1,
      networkOut: 2,
      tokenIn: BYTES32(1),
      tokenOut: BYTES32(2),
      fromAddress: BYTES32(3),
      toAddress: BYTES32(4),
      amount: 10n,
      relayerFee: 2n,
      nonce: BYTES32(5),
    });
    const decoded = codec.decode(bytes);
    assert.strictEqual(decoded.networkIn, 1);
    assert.strictEqual(decoded.networkOut, 2);
    assert.strictEqual(decoded.relayerFee, 2n);
  });

  it("encodes and decodes override outbound events", () => {
    const codec = getOverrideOutboundEventCodec();
    const bytes = codec.encode({
      toAddress: BYTES32(9),
      relayerFee: 7n,
      nonce: BYTES32(8),
    });
    const decoded = codec.decode(bytes);
    assert.strictEqual(decoded.relayerFee, 7n);
  });
});
