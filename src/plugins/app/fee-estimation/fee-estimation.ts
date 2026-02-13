import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import {
  kSolanaCostsEstimation,
  type SolanaCostsEstimation,
} from "./solana-costs-estimation.js";
import {
  kQubicCostsEstimation,
  type QubicCostsEstimation,
} from "./qubic-costs-estimation.js";
import type {
  EstimationInput,
  EstimationOutput,
  ChainCostsEstimation,
} from "./schemas/estimation.js";
import { median } from "../common/maths.js";
import { Network } from "../common/schemas/common.js";
import {
  kOracleService,
  type OracleService,
} from "../oracle-service.js";

const BPS_FEE = 100n;
const PROTOCOL_FEE_BPS_OF_BPS = 1000n;

export const kFeeEstimation = Symbol("fee-estimation");

const MIN_HEALTHY_ORACLES = 4;

export type FeeEstimation = {
  estimate(input: EstimationInput): Promise<EstimationOutput>;
};

export function createFeeEstimationService(
  solanaCosts: SolanaCostsEstimation,
  qubicCosts: ChainCostsEstimation,
  oracleService: OracleService,
): FeeEstimation {
  function computeBridgeFee(amount: bigint) {
    const oracle = (amount * BPS_FEE) / 10_000n;
    const protocol = (oracle * PROTOCOL_FEE_BPS_OF_BPS) / 10_000n;
    return { oracle, protocol, total: oracle + protocol };
  }

  function getRelayerFee(chain: Network): bigint {
    const healthy = oracleService
      .list()
      .filter((o) => o.status === "ok");
    if (healthy.length < MIN_HEALTHY_ORACLES) {
      const err = new Error(
        "Cannot estimate fees: at least 4 healthy oracles required",
      ) as Error & { statusCode?: number };
      err.statusCode = 503;
      throw err;
    }
    const fees = healthy.map((o) =>
      chain === Network.Solana ? o.relayerFeeSolana : o.relayerFeeQubic,
    );
    return median(fees);
  }

  async function getNetworkFee(
    chain: Network,
    input: EstimationInput,
  ): Promise<bigint> {
    if (chain === Network.Solana) {
      return await solanaCosts.estimateUserNetworkFee();
    }
    return await qubicCosts.estimateUserNetworkFee(input);
  }

  return {
    async estimate(input: EstimationInput): Promise<EstimationOutput> {
      const sourceChain = input.networkIn as Network;
      const destChain = input.networkOut as Network;

      if (input.networkIn === input.networkOut) {
        throw new Error(
          `networkIn and networkOut cannot be the same (${input.networkIn})`,
        );
      }

      const bridgeFee = computeBridgeFee(BigInt(input.amount));
      const relayerFee = getRelayerFee(destChain);
      const networkFee = await getNetworkFee(sourceChain, input);
      const userReceives = BigInt(input.amount) - bridgeFee.total - relayerFee;

      return {
        bridgeFee: {
          oracleFee: String(bridgeFee.oracle),
          protocolFee: String(bridgeFee.protocol),
          total: String(bridgeFee.total),
        },
        relayerFee: String(relayerFee),
        networkFee: String(networkFee),
        userReceives: String(userReceives),
      };
    },
  };
}

export default fp(
  async function feeEstimationPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kFeeEstimation)) return;

    const solanaCosts =
      fastify.getDecorator<SolanaCostsEstimation>(kSolanaCostsEstimation);
    const qubicCosts =
      fastify.getDecorator<QubicCostsEstimation>(kQubicCostsEstimation);
    const oracleService =
      fastify.getDecorator<OracleService>(kOracleService);

    fastify.decorate(
      kFeeEstimation,
      createFeeEstimationService(solanaCosts, qubicCosts, oracleService),
    );
  },
  {
    name: "fee-estimation",
    dependencies: [
      "solana-costs-estimation",
      "qubic-costs-estimation",
      "oracle-service",
    ],
  },
);
