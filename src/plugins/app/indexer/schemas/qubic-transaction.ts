import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../common/schemas/common.js";

export const QubicAddressSchema = Type.String({
  minLength: 60,
  maxLength: 60,
  pattern: '^[A-Z]{60}$',
})

export const QubicTransactionSchema = Type.Object({
  sender: StringSchema,
  recipient: StringSchema,
  amount: Type.Number(),
  nonce: Type.Number(),
  origin_trx_hash: StringSchema,
});

export type QubicTransaction = Static<typeof QubicTransactionSchema>;
