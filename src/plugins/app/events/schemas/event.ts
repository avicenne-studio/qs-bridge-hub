import { Static, Type } from "@sinclair/typebox";
import { AmountSchema, StringSchema } from "../../common/schemas/common.js";

const Hex32Schema = Type.String({ pattern: "^[0-9a-fA-F]{64}$" });

export const SolanaEventTypeSchema = Type.Union([
  Type.Literal("outbound"),
  Type.Literal("override-outbound"),
]);

export const SolanaEventChainSchema = Type.Literal("solana");

export const SolanaOutboundEventPayloadSchema = Type.Object({
  networkIn: Type.Integer({ minimum: 0 }),
  networkOut: Type.Integer({ minimum: 0 }),
  tokenIn: Hex32Schema,
  tokenOut: Hex32Schema,
  fromAddress: Hex32Schema,
  toAddress: Hex32Schema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: Hex32Schema,
});

export const SolanaOverrideOutboundEventPayloadSchema = Type.Object({
  toAddress: Hex32Schema,
  relayerFee: AmountSchema,
  nonce: Hex32Schema,
});

export const SolanaEventPayloadSchema = Type.Union([
  SolanaOutboundEventPayloadSchema,
  SolanaOverrideOutboundEventPayloadSchema,
]);

export const StoredEventSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  signature: StringSchema,
  slot: Type.Optional(Type.Integer({ minimum: 0 })),
  chain: SolanaEventChainSchema,
  type: SolanaEventTypeSchema,
  nonce: Hex32Schema,
  payload: SolanaEventPayloadSchema,
  createdAt: StringSchema,
});

export type SolanaEventPayload = Static<typeof SolanaEventPayloadSchema>;
export type StoredEvent = Static<typeof StoredEventSchema>;
