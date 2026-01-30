import { Buffer } from "node:buffer";
import {
  getOutboundEventDecoder,
  type OutboundEvent,
} from "../../../../clients/js/types/outboundEvent.js";
import {
  getInboundEventDecoder,
  type InboundEvent,
} from "../../../../clients/js/types/inboundEvent.js";
import {
  getOverrideOutboundEventDecoder,
  type OverrideOutboundEvent,
} from "../../../../clients/js/types/overrideOutboundEvent.js";

export const LOG_PREFIX = "Program data: ";
export const INBOUND_EVENT_SIZE = 185;
export const OUTBOUND_EVENT_SIZE = 185;
export const OVERRIDE_OUTBOUND_EVENT_SIZE = 73;
const INBOUND_DISCRIMINATOR = 0;
const OUTBOUND_DISCRIMINATOR = 1;
const OVERRIDE_OUTBOUND_DISCRIMINATOR = 2;

const inboundDecoder = getInboundEventDecoder();
const outboundDecoder = getOutboundEventDecoder();
const overrideDecoder = getOverrideOutboundEventDecoder();

export type DecodedProgramEvent =
  | { type: "inbound"; event: InboundEvent }
  | { type: "outbound"; event: OutboundEvent }
  | { type: "override-outbound"; event: OverrideOutboundEvent };

export function logLinesToEvents(logs: string[]): Uint8Array[] {
  const events: Uint8Array[] = [];
  for (const line of logs) {
    if (!line.startsWith(LOG_PREFIX)) {
      continue;
    }
    const encoded = line.slice(LOG_PREFIX.length).trim();
    if (!encoded) {
      continue;
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0) {
      continue;
    }
    events.push(new Uint8Array(decoded));
  }
  return events;
}

export function decodeEventBytes(bytes: Uint8Array): DecodedProgramEvent | null {
  if (bytes.length === 0) {
    return null;
  }
  const discriminator = bytes[0];
  if (discriminator === INBOUND_DISCRIMINATOR) {
    if (bytes.length !== INBOUND_EVENT_SIZE) {
      return null;
    }
    return { type: "inbound", event: inboundDecoder.decode(bytes) };
  }
  if (discriminator === OUTBOUND_DISCRIMINATOR) {
    if (bytes.length !== OUTBOUND_EVENT_SIZE) {
      return null;
    }
    return { type: "outbound", event: outboundDecoder.decode(bytes) };
  }
  if (discriminator === OVERRIDE_OUTBOUND_DISCRIMINATOR) {
    if (bytes.length !== OVERRIDE_OUTBOUND_EVENT_SIZE) {
      return null;
    }
    return { type: "override-outbound", event: overrideDecoder.decode(bytes) };
  }
  return null;
}

export function isKnownEventSize(size: number): boolean {
  return (
    size === INBOUND_EVENT_SIZE ||
    size === OUTBOUND_EVENT_SIZE ||
    size === OVERRIDE_OUTBOUND_EVENT_SIZE
  );
}
