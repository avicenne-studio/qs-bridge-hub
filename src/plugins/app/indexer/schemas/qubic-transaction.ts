import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../common/schemas/common.js";

export const QubicTransactionSchema = Type.Object({
  sender: StringSchema,
  recipient: StringSchema,
  amount: Type.Number(),
  nonce: Type.Number(),
});

export type QubicTransaction = Static<typeof QubicTransactionSchema>;
