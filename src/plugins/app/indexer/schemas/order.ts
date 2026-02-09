import { Static, Type } from "@sinclair/typebox";
import { QubicTransaction } from "./qubic-transaction.js";
import { SolanaTransaction } from "./solana-transaction.js";
import {
  AmountSchema,
  StringSchema,
} from "../../common/schemas/common.js";

const SourcePayloadSchema = Type.String({ minLength: 1, maxLength: 8192 });

export const OracleChain = Type.Union([
  Type.Literal("qubic"),
  Type.Literal("solana"),
]);

export const OracleOrderStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in-progress"),
  Type.Literal("ready-for-relay"),
  Type.Literal("failed"),
  Type.Literal("finalized"),
]);

export const OracleOrderSchema = Type.Object({
  source: OracleChain,
  dest: OracleChain,
  from: StringSchema,
  to: StringSchema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  origin_trx_hash: Type.String({ minLength: 1, maxLength: 255 }),
  source_nonce: Type.Optional(StringSchema),
  source_payload: Type.Optional(SourcePayloadSchema),
  failure_reason_public: Type.Optional(StringSchema),
  oracle_accept_to_relay: Type.Boolean(),
  status: OracleOrderStatus,
});

export type OracleOrder = Static<typeof OracleOrderSchema>;
export type OracleOrderStatusType = Static<typeof OracleOrderStatus>;

export function assertValidOracleOrder(order: OracleOrder) {
  if (order.source === order.dest) {
    throw new Error("OracleOrder: source and dest must differ");
  }
}

export function orderFromQubic(
  tx: QubicTransaction,
  dest: Static<typeof OracleChain>
): OracleOrder {
  const order: OracleOrder = {
    source: "qubic",
    dest,
    from: tx.sender,
    to: tx.recipient,
    amount: String(tx.amount),
    relayerFee: "0",
    origin_trx_hash: tx.origin_trx_hash,
    oracle_accept_to_relay: false,
    status: "in-progress",
  };
  assertValidOracleOrder(order);
  return order;
}

export function orderFromSolana(
  tx: SolanaTransaction,
  dest: Static<typeof OracleChain>
): OracleOrder {
  const ix = tx.instructions[0];
  const decoded = normalizeBridgeInstruction(ix.data);
  const order: OracleOrder = {
    source: "solana",
    dest,
    from: decoded.from,
    to: decoded.to,
    amount: decoded.amount,
    relayerFee: "0",
    origin_trx_hash: tx.signature,
    oracle_accept_to_relay: false,
    status: "in-progress",
  };
  assertValidOracleOrder(order);
  return order;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeBridgeInstruction(_data: string): {
  from: string;
  to: string;
  amount: string;
} {
  throw new Error("normalizeBridgeInstruction not implemented");
}
