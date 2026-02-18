import { Static, Type } from "@sinclair/typebox";
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
  Type.Literal("relayed"),
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
  destination_trx_hash: Type.Optional(
    Type.String({ minLength: 1, maxLength: 255 })
  ),
  source_nonce: StringSchema,
  source_payload: SourcePayloadSchema,
  failure_reason_public: Type.Optional(StringSchema),
  status: OracleOrderStatus,
});

export type OracleOrder = Static<typeof OracleOrderSchema>;
export type OracleOrderStatusType = Static<typeof OracleOrderStatus>;

export function assertValidOracleOrder(order: OracleOrder) {
  if (order.source === order.dest) {
    throw new Error("OracleOrder: source and dest must differ");
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeBridgeInstruction(_data: string): {
  from: string;
  to: string;
  amount: string;
} {
  throw new Error("normalizeBridgeInstruction not implemented");
}
