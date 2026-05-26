import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import { FastifyInstance } from "fastify";
import {
  kUndiciClient,
  UndiciClient,
  type UndiciClientService,
  HttpError,
} from "./undici-client.js";
import { kConfig, type AppConfig } from "./env.js";

const QSB_CONTRACT_INDEX = 28;
const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 300;
const LOCKED_ORDER_ENTRY_SIZE = 168;

export const FUNC_GET_CONFIG = 1;
export const FUNC_GET_LOCKED_ORDER = 4;
export const FUNC_GET_ORACLES = 7;
export const FUNC_GET_LOCKED_ORDERS = 9;
export const FUNC_GET_FILLED_ORDERS = 10;

export type LockedOrder = {
  sender: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  networkOut: number;
  nonce: number;
  toAddress: Uint8Array;
  orderHash: Uint8Array;
  lockEpoch: number;
  orderEra: number;
  active: boolean;
};

export type BridgeConfig = {
  admin: Uint8Array;
  protocolFeeRecipient: Uint8Array;
  oracleFeeRecipient: Uint8Array;
  bpsFee: number;
  protocolFee: number;
  oracleCount: number;
  pauserCount: number;
  oracleThreshold: number;
  paused: boolean;
  orderEra: number;
};

export type QubicContractClient = {
  queryContractFunction(funcNumber: number, inputHex: string): Promise<string>;
  getBobStatus(): Promise<{ epoch: number; tick: number }>;
  getLockedOrders(
    offset: number,
    limit: number,
  ): Promise<{ totalActive: number; returned: number; entries: LockedOrder[] }>;
  getFilledOrders(
    offset: number,
    limit: number,
  ): Promise<{ totalActive: number; returned: number; hashes: Uint8Array[] }>;
  listLockedOrders(limit?: number): Promise<LockedOrder[]>;
  listFilledOrderHashes(limit?: number): Promise<Uint8Array[]>;
};

export const kQubicContractClient = Symbol("infra.qubicContractClient");

export function encodePaginationInput(offset: number, limit: number): string {
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(offset >>> 0, 0);
  buf.writeUInt32LE(limit >>> 0, 4);
  return buf.toString("hex");
}

/**
 * LockedOrderEntry layout (168 bytes, natural C++ alignment, LE):
 *   [+0..+31]    id      sender
 *   [+32..+39]   u64     amount
 *   [+40..+47]   u64     relayerFee
 *   [+48..+51]   u32     networkOut
 *   [+52..+55]   u32     nonce
 *   [+56..+119]  u8[64]  toAddress (ASCII, zero-padded)
 *   [+120..+151] u8[32]  orderHash (K12 digest)
 *   [+152..+155] u32     lockEpoch
 *   [+156..+159] u32     orderEra
 *   [+160]       bit     active (1 byte)
 *   [+161..+167] --      7 bytes padding
 */
function decodeLockedOrderEntry(buf: Buffer, offset: number): LockedOrder {
  return {
    sender: new Uint8Array(buf.subarray(offset, offset + 32)),
    amount: buf.readBigUInt64LE(offset + 32),
    relayerFee: buf.readBigUInt64LE(offset + 40),
    networkOut: buf.readUInt32LE(offset + 48),
    nonce: buf.readUInt32LE(offset + 52),
    toAddress: new Uint8Array(buf.subarray(offset + 56, offset + 120)),
    orderHash: new Uint8Array(buf.subarray(offset + 120, offset + 152)),
    lockEpoch: buf.readUInt32LE(offset + 152),
    orderEra: buf.readUInt32LE(offset + 156),
    active: buf.readUInt8(offset + 160) !== 0,
  };
}

export function decodeGetLockedOrders(hex: string): {
  totalActive: number;
  returned: number;
  entries: LockedOrder[];
} {
  const buf = Buffer.from(hex, "hex");
  const totalActive = buf.readUInt32LE(0);
  const returned = buf.readUInt32LE(4);
  const entries: LockedOrder[] = [];
  for (let i = 0; i < returned; i++) {
    entries.push(decodeLockedOrderEntry(buf, 8 + i * LOCKED_ORDER_ENTRY_SIZE));
  }
  return { totalActive, returned, entries };
}

export function decodeGetFilledOrders(hex: string): {
  totalActive: number;
  returned: number;
  hashes: Uint8Array[];
} {
  const buf = Buffer.from(hex, "hex");
  const totalActive = buf.readUInt32LE(0);
  const returned = buf.readUInt32LE(4);
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < returned; i++) {
    hashes.push(new Uint8Array(buf.subarray(8 + i * 32, 8 + (i + 1) * 32)));
  }
  return { totalActive, returned, hashes };
}

export function decodeGetConfig(hex: string): BridgeConfig {
  const buf = Buffer.from(hex, "hex");
  return {
    admin: new Uint8Array(buf.subarray(0, 32)),
    protocolFeeRecipient: new Uint8Array(buf.subarray(32, 64)),
    oracleFeeRecipient: new Uint8Array(buf.subarray(64, 96)),
    bpsFee: buf.readUInt32LE(96),
    protocolFee: buf.readUInt32LE(100),
    oracleCount: buf.readUInt32LE(104),
    pauserCount: buf.readUInt32LE(108),
    oracleThreshold: buf.readUInt8(112),
    paused: buf.readUInt8(113) !== 0,
    orderEra: buf.readUInt32LE(116), // [114..115] is 2-byte alignment padding
  };
}

export function createQubicContractClient(
  client: UndiciClient,
  bobUrl: string,
): QubicContractClient {
  const { origin } = new URL(bobUrl);
  return {
    async queryContractFunction(
      funcNumber: number,
      inputHex: string,
    ): Promise<string> {
      const nonce = (Math.random() * 0xffffffff) >>> 0;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS),
          );
        }
        let body: { error?: string; data?: unknown };
        try {
          body = await client.postJson<{ error?: string; data?: unknown }>(
            origin,
            "/querySmartContract",
            { nonce, scIndex: QSB_CONTRACT_INDEX, funcNumber, data: inputHex },
          );
        } catch (err) {
          if (err instanceof HttpError) {
            throw new Error(
              `querySmartContract HTTP ${err.statusCode}: ${JSON.stringify(err.body)}`,
            );
          }
          throw err;
        }
        if (body.error === "pending") continue; // Bob Node returns 200 { error: "pending" } until ready
        if (typeof body.data !== "string") {
          throw new Error(
            `querySmartContract: unexpected response: ${JSON.stringify(body)}`,
          );
        }
        return body.data;
      }
      throw new Error(
        `querySmartContract func=${funcNumber}: still pending after ${MAX_RETRIES} retries`,
      );
    },

    async getBobStatus() {
      const body = await client.getJson<Record<string, unknown>>(
        origin,
        "/status",
      );
      return {
        epoch: Number(body.currentProcessingEpoch ?? body.epoch ?? 0),
        tick: Number(body.tick ?? 0),
      };
    },

    async getLockedOrders(offset: number, limit: number) {
      const hex = await this.queryContractFunction(
        FUNC_GET_LOCKED_ORDERS,
        encodePaginationInput(offset, limit),
      );
      return decodeGetLockedOrders(hex);
    },

    async getFilledOrders(offset: number, limit: number) {
      const hex = await this.queryContractFunction(
        FUNC_GET_FILLED_ORDERS,
        encodePaginationInput(offset, limit),
      );
      return decodeGetFilledOrders(hex);
    },

    async listLockedOrders(limit = 64) {
      const entries: LockedOrder[] = [];
      for (let offset = 0; ; offset += limit) {
        const page = await this.getLockedOrders(offset, limit);
        entries.push(...page.entries);
        if (page.returned < limit || entries.length >= page.totalActive) {
          break;
        }
      }
      return entries;
    },

    async listFilledOrderHashes(limit = 64) {
      const hashes: Uint8Array[] = [];
      for (let offset = 0; ; offset += limit) {
        const page = await this.getFilledOrders(offset, limit);
        hashes.push(...page.hashes);
        if (page.returned < limit || hashes.length >= page.totalActive) {
          break;
        }
      }
      return hashes;
    },

  };
}

export default fp(
  async function qubicContractClientPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kQubicContractClient)) return;
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);
    fastify.decorate(
      kQubicContractClient,
      createQubicContractClient(undiciService.create(), config.QUBIC_BOB_URL),
    );
  },
  {
    name: "qubic-contract-client",
    dependencies: ["env", "undici-client"],
  },
);
