import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  decodeEventBytes,
  isKnownEventSize,
  logLinesToEvents,
} from "../../../../src/plugins/app/listener/solana/solana-program-logs.js";
import {
  createInboundEventBytes,
  createOutboundEventBytes,
  createOverrideEventBytes,
} from "../../../helpers/solana-events.js";

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
    assert.strictEqual(override.event.relayerFee, 7n);

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

  it("returns null for empty or wrong-size event bytes", () => {
    assert.strictEqual(decodeEventBytes(new Uint8Array()), null);
    assert.strictEqual(decodeEventBytes(new Uint8Array([0, 1])), null);
    assert.strictEqual(decodeEventBytes(new Uint8Array([1, 1])), null);
    assert.strictEqual(decodeEventBytes(new Uint8Array([2, 1])), null);
  });
});
