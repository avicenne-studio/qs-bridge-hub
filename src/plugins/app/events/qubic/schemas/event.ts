import { Static, Type } from "@sinclair/typebox";
import { AmountSchema, StringSchema } from "../../../common/schemas/common.js";
import { createStoredEventSchema } from "../../schemas/base.js";

export const QubicEventChainSchema = Type.Literal("qubic");

export const QubicEventTypeSchema = Type.Union([
  Type.Literal("lock"),
  Type.Literal("override-lock"),
  Type.Literal("unlock"),
]);

export const QubicLockEventPayloadSchema = Type.Object({
  fromAddress: StringSchema,
  toAddress: StringSchema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: StringSchema,
  orderEra: Type.String({ pattern: "^[0-9]+$" }),
});

export const QubicOverrideLockEventPayloadSchema = Type.Object({
  toAddress: StringSchema,
  relayerFee: AmountSchema,
  nonce: StringSchema,
  fromAddress: StringSchema,
  amount: AmountSchema,
  orderEra: Type.String({ pattern: "^[0-9]+$" }),
});

export const QubicUnlockEventPayloadSchema = Type.Object({
  toAddress: StringSchema,
  amount: AmountSchema,
  // Unlock logs do not carry a nonce. When the corresponding lock log was not
  // seen in this hub session, the poller persists an empty-string fallback.
  nonce: Type.String({ maxLength: 255 }),
});

export const QubicEventPayloadSchema = Type.Union([
  QubicLockEventPayloadSchema,
  QubicOverrideLockEventPayloadSchema,
  QubicUnlockEventPayloadSchema,
]);

export const QubicStoredEventSchema = createStoredEventSchema({
  chain: QubicEventChainSchema,
  type: QubicEventTypeSchema,
  nonce: StringSchema,
  payload: QubicEventPayloadSchema,
});

export type QubicEventPayload = Static<typeof QubicEventPayloadSchema>;
export type QubicStoredEvent = Static<typeof QubicStoredEventSchema>;
