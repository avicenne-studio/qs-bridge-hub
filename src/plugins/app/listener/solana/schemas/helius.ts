import { type Static, Type } from "@sinclair/typebox";

export const HeliusTransactionSchema = Type.Object(
  {
    transaction: Type.Object(
      {
        signatures: Type.Array(Type.String()),
      },
      { additionalProperties: true },
    ),
    slot: Type.Number(),
    meta: Type.Object(
      {
        err: Type.Union([Type.Null(), Type.Unknown()]),
        logMessages: Type.Union([Type.Array(Type.String()), Type.Null()]),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

export const HeliusRpcResultSchema = Type.Object({
  data: Type.Array(HeliusTransactionSchema),
  paginationToken: Type.Union([Type.String(), Type.Null()]),
});

export const HeliusRpcResponseSchema = Type.Object(
  {
    result: Type.Optional(
      Type.Object(
        {
          data: Type.Optional(Type.Array(HeliusTransactionSchema)),
          paginationToken: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: true },
      ),
    ),
    error: Type.Optional(
      Type.Object(
        {
          message: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export type HeliusTransaction = Static<typeof HeliusTransactionSchema>;
export type HeliusRpcResult = Static<typeof HeliusRpcResultSchema>;
export type HeliusRpcResponse = Static<typeof HeliusRpcResponseSchema>;
