import { Type } from "@sinclair/typebox";
import { StringSchema } from "../../common/schemas/common.js";

export function createStoredEventSchema(opts: {
  chain: ReturnType<typeof Type.Literal> | ReturnType<typeof Type.Union>;
  type: ReturnType<typeof Type.Literal> | ReturnType<typeof Type.Union>;
  nonce: ReturnType<typeof Type.String>;
  payload: ReturnType<typeof Type.Union> | ReturnType<typeof Type.Object>;
}) {
  return Type.Object({
    id: Type.Integer({ minimum: 1 }),
    signature: StringSchema,
    slot: Type.Optional(Type.Integer({ minimum: 0 })),
    chain: opts.chain,
    type: opts.type,
    nonce: opts.nonce,
    payload: opts.payload,
    createdAt: StringSchema,
  });
}
