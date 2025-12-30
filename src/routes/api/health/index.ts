import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";

const BridgeHealthResponseSchema = Type.Object({
  paused: Type.Literal(true),
});

const OracleHealthSchema = Type.Object({
  url: Type.String({ format: "uri" }),
  status: Type.Union([Type.Literal("ok"), Type.Literal("down")]),
  timestamp: Type.String({ format: "date-time" }),
});

const OraclesHealthResponseSchema = Type.Object({
  oracles: Type.Array(OracleHealthSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    "/bridge",
    {
      schema: {
        response: {
          200: BridgeHealthResponseSchema,
        },
      },
    },
    async function handler() {
      return { paused: true } as const;
    }
  );

  fastify.get(
    "/oracles",
    {
      schema: {
        response: {
          200: OraclesHealthResponseSchema,
        },
      },
    },
    async function handler() {
      return {
        oracles: fastify.oracleService.list(),
      };
    }
  );
};

export default plugin;
