import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  decodeEventBytes,
  isKnownEventSize,
  logLinesToEvents,
} from "../../../../src/plugins/app/listener/solana/solana-program-logs.js";
import { getInboundEventEncoder } from "../../../../src/clients/js/types/inboundEvent.js";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";

function createInboundEventBytes() {
  const encoder = getInboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      discriminator: 0,
      networkIn: 1,
      networkOut: 2,
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

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      discriminator: 1,
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
      discriminator: 2,
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
    const inboundBytes = createInboundEventBytes();
    const outboundBytes = createOutboundEventBytes();
    const overrideBytes = createOverrideEventBytes();

    const inbound = decodeEventBytes(inboundBytes);
    assert.ok(inbound);
    assert.strictEqual(inbound.type, "inbound");
    assert.strictEqual(inbound.event.networkOut, 2);

    const outbound = decodeEventBytes(outboundBytes);
    assert.ok(outbound);
    assert.strictEqual(outbound.type, "outbound");
    assert.strictEqual(outbound.event.networkOut, 1);

    const override = decodeEventBytes(overrideBytes);
    assert.ok(override);
    assert.strictEqual(override.type, "override-outbound");
    assert.strictEqual(override.event.relayerFee, 3n);

    assert.ok(isKnownEventSize(inboundBytes.length));
    assert.ok(isKnownEventSize(outboundBytes.length));
    assert.ok(isKnownEventSize(overrideBytes.length));
    assert.strictEqual(decodeEventBytes(new Uint8Array(12)), null);
    assert.strictEqual(decodeEventBytes(new Uint8Array()), null);
    const badOutbound = outboundBytes.slice(0, outboundBytes.length - 1);
    badOutbound[0] = 1;
    assert.strictEqual(decodeEventBytes(badOutbound), null);
    const badOverride = overrideBytes.slice(0, overrideBytes.length - 1);
    badOverride[0] = 2;
    assert.strictEqual(decodeEventBytes(badOverride), null);
    assert.strictEqual(decodeEventBytes(new Uint8Array([9, 1, 2])), null);
    assert.strictEqual(isKnownEventSize(12), false);
  });
});
