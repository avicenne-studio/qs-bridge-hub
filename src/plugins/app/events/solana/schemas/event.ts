import { Static, Type } from "@sinclair/typebox";
import {
  AmountSchema,
  NetworkIdSchema,
} from "../../../common/schemas/common.js";
import { createStoredEventSchema } from "../../schemas/base.js";

const Hex32Schema = Type.String({ pattern: "^[0-9a-fA-F]{64}$" });

export const SolanaEventTypeSchema = Type.Union([
  Type.Literal("outbound"),
  Type.Literal("override-outbound"),
  Type.Literal("inbound"),
]);

export const SolanaEventChainSchema = Type.Literal("solana");

export const SolanaOutboundEventPayloadSchema = Type.Object({
  networkIn: NetworkIdSchema,
  networkOut: NetworkIdSchema,
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

export const SolanaInboundEventPayloadSchema = Type.Object({
  networkIn: NetworkIdSchema,
  networkOut: NetworkIdSchema,
  tokenIn: Hex32Schema,
  tokenOut: Hex32Schema,
  fromAddress: Hex32Schema,
  toAddress: Hex32Schema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: Hex32Schema,
});

export const SolanaEventPayloadSchema = Type.Union([
  SolanaOutboundEventPayloadSchema,
  SolanaOverrideOutboundEventPayloadSchema,
  SolanaInboundEventPayloadSchema,
]);

export const StoredEventSchema = createStoredEventSchema({
  chain: SolanaEventChainSchema,
  type: SolanaEventTypeSchema,
  nonce: Hex32Schema,
  payload: SolanaEventPayloadSchema,
});

export type SolanaEventPayload = Static<typeof SolanaEventPayloadSchema>;
export type StoredEvent = Static<typeof StoredEventSchema>;
