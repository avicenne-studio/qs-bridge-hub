import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";

const BridgeHealthResponseSchema = Type.Object({
  paused: Type.Literal(true),
});

const OracleHealthSchema = Type.Object({
  url: Type.String({ format: "uri" }),
  status: Type.Literal("ok"),
  timestamp: Type.String({ format: "date-time" }),
});

const OraclesHealthResponseSchema = Type.Object({
  oracles: Type.Array(OracleHealthSchema),
});

const DEFAULT_ORACLE_URLS = [
  "https://oracle-1.example",
  "https://oracle-2.example",
] as const;

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
      return { paused: true } as const
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
      const timestamp = new Date().toISOString();
      return {
        oracles: DEFAULT_ORACLE_URLS.map((url) => ({
          url,
          status: "ok" as const,
          timestamp,
        })),
      };
    }
  );
};

export default plugin;
