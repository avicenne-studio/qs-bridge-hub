import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  decodeEventBytes,
  isKnownEventSize,
  logLinesToEvents,
} from "../../../../src/plugins/app/listener/solana/solana-program-logs.js";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      networkIn: 1,
      networkOut: 1,
      tokenIn: new Uint8Array(32).fill(1),
      tokenOut: new Uint8Array(32).fill(2),
      fromAddress: new Uint8Array(32).fill(3),
      toAddress: new Uint8Array(32).fill(4),
      amount: 10n,
      relayerFee: 2n,
      nonce: new Uint8Array(32).fill(5),
    })
  );
}

function createOverrideEventBytes() {
  const encoder = getOverrideOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      toAddress: new Uint8Array(32).fill(7),
      relayerFee: 3n,
      nonce: new Uint8Array(32).fill(8),
    })
  );
}

describe("solana program log decoding", () => {
  it("extracts program data log lines", () => {
    const outboundBytes = createOutboundEventBytes();
    const line = `Program data: ${Buffer.from(outboundBytes).toString("base64")}`;
    const events = logLinesToEvents([
      "Program log: ignore",
      "Program data: ",
      "Program data: !!!",
      line,
    ]);
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], outboundBytes);
  });

  it("decodes outbound and override event sizes", () => {
    const outboundBytes = createOutboundEventBytes();
    const overrideBytes = createOverrideEventBytes();

    const outbound = decodeEventBytes(outboundBytes);
    assert.ok(outbound);
    assert.strictEqual(outbound.type, "outbound");
    assert.strictEqual(outbound.event.networkOut, 1);

    const override = decodeEventBytes(overrideBytes);
    assert.ok(override);
    assert.strictEqual(override.type, "override-outbound");
    assert.strictEqual(override.event.relayerFee, 3n);

    assert.ok(isKnownEventSize(outboundBytes.length));
    assert.ok(isKnownEventSize(overrideBytes.length));
    assert.strictEqual(decodeEventBytes(new Uint8Array(12)), null);
    assert.strictEqual(isKnownEventSize(12), false);
  });
});
