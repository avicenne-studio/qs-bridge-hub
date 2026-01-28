import { Buffer } from "node:buffer";
import { type ReadonlyUint8Array } from "@solana/kit";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;
const HEX_PATTERN = /^[0-9a-fA-F]*$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function bytesToHex(value: ReadonlyUint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (normalized.length % 2 !== 0) {
    throw new Error("SolanaListener: hex value must be byte aligned");
  }
  if (!HEX_PATTERN.test(normalized)) {
    throw new Error("SolanaListener: hex value contains non-hex characters");
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

export function toSafeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new Error(`SolanaListener: ${field} exceeds max safe integer`);
  }
  return Number(value);
}

export function toSafeBigInt(value: number, field: string): bigint {
  if (!Number.isInteger(value)) {
    throw new Error(`SolanaListener: ${field} must be an integer`);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`SolanaListener: ${field} exceeds max safe integer`);
  }
  return BigInt(value);
}

export function toU64BigInt(value: string, field: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`SolanaListener: ${field} must be an integer string`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_U64) {
    throw new Error(`SolanaListener: ${field} exceeds uint64`);
  }
  return parsed;
}
