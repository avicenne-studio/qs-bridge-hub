import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type ValidationService = {
  isValid<T>(schema: TSchema, value: unknown): value is T;
  assertValid<T>(
    schema: TSchema,
    value: unknown,
    prefix: string
  ): asserts value is T;
};

export const kValidation = Symbol("app.validation");

export function formatFirstError(schema: TSchema, value: unknown) {
  for (const error of Value.Errors(schema, value)) {
    return `${error.message} at ${error.path}`;
  }
  return "Invalid schema";
}

function createValidation(): ValidationService {
  return {
    isValid<T>(schema: TSchema, value: unknown): value is T {
      return Value.Check(schema, value);
    },
    assertValid<T>(
      schema: TSchema,
      value: unknown,
      prefix: string
    ): asserts value is T {
      if (!Value.Check(schema, value)) {
        const errorMessage = formatFirstError(schema, value);
        throw new Error(`${prefix}: invalid schema - ${errorMessage}`);
      }
    },
  };
}

export default fp(
  async function validationPlugin(fastify: FastifyInstance) {
    fastify.decorate(kValidation, createValidation());
  },
  { name: "validation" }
);
