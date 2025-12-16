import { Static, Type } from "@sinclair/typebox";
import { QubicTransaction } from "./qubic-transaction.js";
import { SolanaTransaction } from "./solana-transaction.js";
import { StringSchema } from "../../common/schemas/common.js";

export const OracleChain = Type.Union([
  Type.Literal("qubic"),
  Type.Literal("solana"),
]);

export const OracleOrderStatus = Type.Union([
  Type.Literal("in-progress"),
  Type.Literal("finalized"),
]);

export const OracleOrderSchema = Type.Object({
  source: OracleChain,
  dest: OracleChain,
  from: StringSchema,
  to: StringSchema,
  amount: Type.Number(),
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
    amount: tx.amount,
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
    status: "in-progress",
  };
  assertValidOracleOrder(order);
  return order;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeBridgeInstruction(_data: string): {
  from: string;
  to: string;
  amount: number;
} {
  throw new Error("normalizeBridgeInstruction not implemented");
}
