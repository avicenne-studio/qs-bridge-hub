import { Buffer } from "node:buffer";
import { getOutboundEventEncoder } from "../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../src/clients/js/types/overrideOutboundEvent.js";
import { getInboundEventEncoder } from "../../src/clients/js/types/inboundEvent.js";
import { LOG_PREFIX } from "../../src/plugins/app/listener/solana/solana-program-logs.js";

export const NONCE = (n: number) => {
  const arr = new Uint8Array(32);
  arr[31] = n;
  return arr;
};

export const BYTES32 = (fill: number) => new Uint8Array(32).fill(fill);

export const BASE_EVENT_DATA = {
  networkIn: 1,
  networkOut: 2,
  tokenIn: BYTES32(1),
  tokenOut: BYTES32(2),
  fromAddress: BYTES32(3),
  toAddress: BYTES32(4),
  amount: 10n,
  relayerFee: 2n,
};

export function createOutboundEventBytes(nonce: Uint8Array = NONCE(1)): Uint8Array {
  return new Uint8Array(
    getOutboundEventEncoder().encode({
      discriminator: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: BYTES32(1),
      tokenOut: BYTES32(2),
      fromAddress: BYTES32(3),
      toAddress: BYTES32(4),
      amount: 10n,
      relayerFee: 2n,
      nonce,
    })
  );
}

export function createOverrideEventBytes(nonce: Uint8Array = NONCE(1)): Uint8Array {
  return new Uint8Array(
    getOverrideOutboundEventEncoder().encode({
      discriminator: 2,
      toAddress: BYTES32(9),
      relayerFee: 7n,
      nonce,
    })
  );
}

export function createInboundEventBytes(nonce: Uint8Array = NONCE(1)): Uint8Array {
  return new Uint8Array(
    getInboundEventEncoder().encode({
      discriminator: 0,
      networkIn: 1,
      networkOut: 2,
      tokenIn: BYTES32(1),
      tokenOut: BYTES32(2),
      fromAddress: BYTES32(3),
      toAddress: BYTES32(4),
      amount: 10n,
      relayerFee: 2n,
      nonce,
    })
  );
}

export function createEventBytes(
  type: "outbound" | "override" | "inbound"
): Uint8Array {
  if (type === "outbound") {
    return new Uint8Array(
      getOutboundEventEncoder().encode({
        discriminator: 1,
        ...BASE_EVENT_DATA,
        networkOut: 1,
        nonce: NONCE(1),
      })
    );
  }
  if (type === "override") {
    return new Uint8Array(
      getOverrideOutboundEventEncoder().encode({
        discriminator: 2,
        toAddress: BYTES32(9),
        relayerFee: 7n,
        nonce: NONCE(2),
      })
    );
  }
  return new Uint8Array(
    getInboundEventEncoder().encode({
      discriminator: 0,
      ...BASE_EVENT_DATA,
      nonce: NONCE(3),
    })
  );
}

export function toLogLine(bytes: Uint8Array): string {
  return LOG_PREFIX + Buffer.from(bytes).toString("base64");
}

export type StoredEvent = {
  id: number;
  signature: string;
  slot: number | null;
  chain: "solana" | "qubic";
  type: "outbound" | "override-outbound" | "lock" | "override-lock";
  nonce: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function createInMemoryEventsRepository() {
  const store: StoredEvent[] = [];
  let nextId = 1;
  return {
    store,
    async create(event: Omit<StoredEvent, "id" | "createdAt">) {
      const created = {
        id: nextId++,
        createdAt: new Date().toISOString(),
        ...event,
      };
      store.push(created);
      return created;
    },
    async listAfter(afterId: number, limit: number) {
      return store.filter((e) => e.id > afterId).slice(0, limit);
    },
    async findExistingSignatures(signatures: string[]) {
      const existing = new Set(store.map((e) => e.signature));
      return signatures.filter((sig) => existing.has(sig));
    },
  };
}
