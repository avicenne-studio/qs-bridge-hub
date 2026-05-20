import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import Fastify from "fastify";

import {
  queryContractFunction,
  decodeGetLockedOrders,
  decodeGetFilledOrders,
  decodeGetConfig,
  encodePaginationInput,
  FUNC_GET_CONFIG,
  FUNC_GET_LOCKED_ORDERS,
  FUNC_GET_FILLED_ORDERS,
} from "../../../src/plugins/app/qubic/contract-client.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a raw LockedOrderEntry buffer (168 bytes) with known values. */
function buildLockedOrderEntryBuf(opts: {
  sender?: Uint8Array;
  amount?: bigint;
  relayerFee?: bigint;
  networkOut?: number;
  nonce?: number;
  toAddress?: string;
  orderHash?: Uint8Array;
  lockEpoch?: number;
  orderEra?: number;
  active?: boolean;
} = {}): Buffer {
  const buf = Buffer.alloc(168);
  const sender = opts.sender ?? new Uint8Array(32).fill(0xaa);
  const amount = opts.amount ?? 1000n;
  const relayerFee = opts.relayerFee ?? 10n;
  const networkOut = opts.networkOut ?? 2;
  const nonce = opts.nonce ?? 42;
  const toAddrStr = opts.toAddress ?? "SolanaAddressHere";
  const orderHash = opts.orderHash ?? new Uint8Array(32).fill(0xff);
  const lockEpoch = opts.lockEpoch ?? 100;
  const orderEra = opts.orderEra ?? 0;
  const active = opts.active ?? true;

  buf.set(sender, 0);
  buf.writeBigUInt64LE(amount, 32);
  buf.writeBigUInt64LE(relayerFee, 40);
  buf.writeUInt32LE(networkOut, 48);
  buf.writeUInt32LE(nonce, 52);
  buf.write(toAddrStr.slice(0, 64), 56, "ascii");
  buf.set(orderHash, 120);
  buf.writeUInt32LE(lockEpoch, 152);
  buf.writeUInt32LE(orderEra, 156);
  buf.writeUInt8(active ? 1 : 0, 160);
  return buf;
}

/** Start a Fastify mock server and return its base URL. */
async function startMockServer(
  t: import("node:test").TestContext,
  handler: (body: unknown) => unknown,
): Promise<string> {
  const server = Fastify({ logger: false });
  server.post("/querySmartContract", async (req) => handler(req.body));
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  t.after(() => server.close());
  return `http://127.0.0.1:${addr.port}`;
}

// ── decodeGetConfig ───────────────────────────────────────────────────────────

describe("decodeGetConfig", () => {
  it("decodes all config fields correctly", () => {
    // GetConfig_output is 120 bytes
    const buf = Buffer.alloc(120);
    buf.fill(0xaa, 0, 32);   // admin
    buf.fill(0xbb, 32, 64);  // protocolFeeRecipient
    buf.fill(0xcc, 64, 96);  // oracleFeeRecipient
    buf.writeUInt32LE(100, 96);  // bpsFee
    buf.writeUInt32LE(20, 100);  // protocolFee
    buf.writeUInt32LE(3, 104);   // oracleCount
    buf.writeUInt32LE(1, 108);   // pauserCount
    buf.writeUInt8(67, 112);     // oracleThreshold
    buf.writeUInt8(0, 113);      // paused = false
    // [114..115] padding
    buf.writeUInt32LE(5, 116);   // orderEra

    const cfg = decodeGetConfig(buf.toString("hex"));
    assert.deepStrictEqual(cfg.admin, new Uint8Array(32).fill(0xaa));
    assert.deepStrictEqual(cfg.protocolFeeRecipient, new Uint8Array(32).fill(0xbb));
    assert.deepStrictEqual(cfg.oracleFeeRecipient, new Uint8Array(32).fill(0xcc));
    assert.strictEqual(cfg.bpsFee, 100);
    assert.strictEqual(cfg.protocolFee, 20);
    assert.strictEqual(cfg.oracleCount, 3);
    assert.strictEqual(cfg.pauserCount, 1);
    assert.strictEqual(cfg.oracleThreshold, 67);
    assert.strictEqual(cfg.paused, false);
    assert.strictEqual(cfg.orderEra, 5);
  });

  it("decodes paused=true when bit is non-zero", () => {
    const buf = Buffer.alloc(120);
    buf.writeUInt8(1, 113);
    const cfg = decodeGetConfig(buf.toString("hex"));
    assert.strictEqual(cfg.paused, true);
  });
});

// ── decodeGetLockedOrders ─────────────────────────────────────────────────────

describe("decodeGetLockedOrders", () => {
  it("decodes totalActive, returned and entries", () => {
    const entry = buildLockedOrderEntryBuf({
      nonce: 55,
      amount: 9999n,
      relayerFee: 99n,
      networkOut: 2,
      toAddress: "SolAddr",
      orderHash: new Uint8Array(32).fill(0x11),
      orderEra: 3,
      active: true,
    });
    const buf = Buffer.alloc(8 + 64 * 168);
    buf.writeUInt32LE(10, 0);  // totalActive
    buf.writeUInt32LE(1, 4);   // returned
    buf.set(entry, 8);

    const result = decodeGetLockedOrders(buf.toString("hex"));
    assert.strictEqual(result.totalActive, 10);
    assert.strictEqual(result.returned, 1);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].nonce, 55);
    assert.strictEqual(result.entries[0].amount, 9999n);
    assert.strictEqual(result.entries[0].relayerFee, 99n);
    assert.strictEqual(result.entries[0].networkOut, 2);
    assert.deepStrictEqual(result.entries[0].orderHash, new Uint8Array(32).fill(0x11));
    assert.strictEqual(result.entries[0].orderEra, 3);
    assert.strictEqual(result.entries[0].active, true);
  });

  it("decodes two entries at correct offsets", () => {
    const e1 = buildLockedOrderEntryBuf({ nonce: 1, amount: 100n });
    const e2 = buildLockedOrderEntryBuf({ nonce: 2, amount: 200n });
    const buf = Buffer.alloc(8 + 64 * 168);
    buf.writeUInt32LE(2, 0);
    buf.writeUInt32LE(2, 4);
    buf.set(e1, 8);
    buf.set(e2, 8 + 168);

    const result = decodeGetLockedOrders(buf.toString("hex"));
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.entries[0].nonce, 1);
    assert.strictEqual(result.entries[1].nonce, 2);
    assert.strictEqual(result.entries[1].amount, 200n);
  });

  it("returns empty entries when returned is 0", () => {
    const buf = Buffer.alloc(8 + 64 * 168);
    const result = decodeGetLockedOrders(buf.toString("hex"));
    assert.strictEqual(result.entries.length, 0);
  });
});

// ── decodeGetFilledOrders ─────────────────────────────────────────────────────

describe("decodeGetFilledOrders", () => {
  it("decodes totalActive, returned and hashes", () => {
    const hash1 = new Uint8Array(32).fill(0x11);
    const hash2 = new Uint8Array(32).fill(0x22);
    const buf = Buffer.alloc(8 + 64 * 32);
    buf.writeUInt32LE(50, 0);  // totalActive
    buf.writeUInt32LE(2, 4);   // returned
    buf.set(hash1, 8);
    buf.set(hash2, 40);

    const result = decodeGetFilledOrders(buf.toString("hex"));
    assert.strictEqual(result.totalActive, 50);
    assert.strictEqual(result.returned, 2);
    assert.strictEqual(result.hashes.length, 2);
    assert.deepStrictEqual(result.hashes[0], hash1);
    assert.deepStrictEqual(result.hashes[1], hash2);
  });

  it("returns empty hashes when returned is 0", () => {
    const buf = Buffer.alloc(8 + 64 * 32);
    const result = decodeGetFilledOrders(buf.toString("hex"));
    assert.strictEqual(result.hashes.length, 0);
  });
});

// ── encodePaginationInput ─────────────────────────────────────────────────────

describe("encodePaginationInput", () => {
  it("encodes offset and limit as 8-byte LE hex", () => {
    const hex = encodePaginationInput(10, 64);
    const buf = Buffer.from(hex, "hex");
    assert.strictEqual(buf.length, 8);
    assert.strictEqual(buf.readUInt32LE(0), 10);
    assert.strictEqual(buf.readUInt32LE(4), 64);
  });
});

// ── queryContractFunction ─────────────────────────────────────────────────────

describe("queryContractFunction", () => {
  it("returns data hex on success", async (t) => {
    const url = await startMockServer(t, () => ({ data: "cafebabe" }));
    const result = await queryContractFunction(url, FUNC_GET_CONFIG, "");
    assert.strictEqual(result, "cafebabe");
  });

  it("throws on HTTP error", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/querySmartContract", async (_req, reply) =>
      reply.code(503).send("unavailable"),
    );
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${(addr as import("node:net").AddressInfo).port}`;
    t.after(() => server.close());

    await assert.rejects(
      () => queryContractFunction(url, FUNC_GET_CONFIG, ""),
      /querySmartContract HTTP 503/,
    );
  });

  it("throws after max retries when always pending", async (t) => {
    const url = await startMockServer(t, () => ({ error: "pending" }));
    await assert.rejects(
      () => queryContractFunction(url, FUNC_GET_LOCKED_ORDERS, encodePaginationInput(0, 64)),
      /still pending after/,
    );
  }, { timeout: 10_000 });

  it("retries and succeeds after one pending response", async (t) => {
    let calls = 0;
    const url = await startMockServer(t, () => {
      calls++;
      return calls === 1 ? { error: "pending" } : { data: "1234" };
    });
    const result = await queryContractFunction(url, FUNC_GET_FILLED_ORDERS, encodePaginationInput(0, 64));
    assert.strictEqual(result, "1234");
    assert.strictEqual(calls, 2);
  });

  it("throws on unexpected response shape", async (t) => {
    const url = await startMockServer(t, () => ({ nope: true }));
    await assert.rejects(
      () => queryContractFunction(url, FUNC_GET_CONFIG, ""),
      /unexpected response/,
    );
  });
});
