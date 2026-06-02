import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  kOracleService,
  OracleService,
} from "../../../plugins/app/oracle-service.js";
import {
  kBridgeState,
  type BridgeState,
} from "../../../plugins/app/bridge-state.js";

const BridgeHealthResponseSchema = Type.Object({
  paused: Type.Boolean(),
});

const OracleHealthSchema = Type.Object({
  url: Type.String({ format: "uri" }),
  status: Type.Union([Type.Literal("ok"), Type.Literal("down")]),
  timestamp: Type.String({ format: "date-time" }),
  relayerFeeToSolana: Type.String({ pattern: "^[0-9]+$" }),
  relayerFeeToQubic: Type.String({ pattern: "^[0-9]+$" }),
});

const OraclesHealthResponseSchema = Type.Object({
  oracles: Type.Array(OracleHealthSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const oracleService = fastify.getDecorator<OracleService>(kOracleService);
  const bridgeState = fastify.getDecorator<BridgeState>(kBridgeState);

  fastify.get(
    "/bridge",
    {
      schema: {
        summary: "Bridge health",
        description: "Returns basic bridge status flags.",
        tags: ["Health"],
        response: {
          200: BridgeHealthResponseSchema,
        },
      },
    },
    async function handler() {
      const { solana, qubic } = await bridgeState.getPauseState();
      return { paused: solana || qubic };
    }
  );

  fastify.get(
    "/oracles",
    {
      schema: {
        summary: "Oracle health registry",
        description:
          "Returns the latest health snapshot of configured oracles, including relayer fee configuration.",
        tags: ["Health"],
        response: {
          200: OraclesHealthResponseSchema,
        },
      },
    },
    async function handler() {
      return {
        oracles: oracleService.list().map((entry) => ({
          ...entry,
          relayerFeeToSolana: entry.relayerFeeToSolana.toString(),
          relayerFeeToQubic: entry.relayerFeeToQubic.toString(),
        })),
      };
    }
  );
};

export default plugin;
