import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  kOracleService,
  OracleService,
} from "../../../plugins/app/oracle-service.js";

const BridgeHealthResponseSchema = Type.Object({
  paused: Type.Literal(true),
});

const OracleHealthSchema = Type.Object({
  url: Type.String({ format: "uri" }),
  status: Type.Union([Type.Literal("ok"), Type.Literal("down")]),
  timestamp: Type.String({ format: "date-time" }),
  relayerFeeSolana: Type.Union([
    Type.String({ pattern: "^[0-9]+$" }),
    Type.Null(),
  ]),
  relayerFeeQubic: Type.Union([
    Type.String({ pattern: "^[0-9]+$" }),
    Type.Null(),
  ]),
});

const OraclesHealthResponseSchema = Type.Object({
  oracles: Type.Array(OracleHealthSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const oracleService = fastify.getDecorator<OracleService>(kOracleService);

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
        oracles: oracleService.list(),
      };
    }
  );
};

export default plugin;
