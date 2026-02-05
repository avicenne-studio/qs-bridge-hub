import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../common/schemas/common.js";

export const SolanaInstructionSchema = Type.Object({
  programId: StringSchema,
  accounts: Type.Array(StringSchema),
  data: StringSchema,
});

export const SolanaTransactionSchema = Type.Object({
  signature: StringSchema,
  recentBlockhash: StringSchema,
  feePayer: StringSchema,
  instructions: Type.Array(SolanaInstructionSchema),
});

export type SolanaTransaction = Static<typeof SolanaTransactionSchema>;
export type SolanaInstruction = Static<typeof SolanaInstructionSchema>;
