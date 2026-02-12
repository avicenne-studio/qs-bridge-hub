import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import {
  kSolanaCostsEstimation,
  type SolanaCostsEstimationService,
} from "./solana-costs-estimation.js";
import {
  kQubicCostsEstimation,
  type QubicCostsEstimationService,
} from "./qubic-costs-estimation.js";
import type {
  SimulationInput,
  SimulationOutput,
} from "./common/schemas/simulation.js";
import { BPS_FEE, PROTOCOL_FEE_BPS_OF_BPS } from "./common/solana.js";
import { NETWORK_SOLANA } from "../common/schemas/common.js";
import {
  MOCK_RELAYER_FEE_QUBIC,
  MOCK_RELAYER_FEE_SOLANA,
} from "./common/mocks.js";

export const kFeeEstimation = Symbol("fee-estimation");

export class FeeEstimationService {
  private readonly solanaCosts: SolanaCostsEstimationService;
  private readonly qubicCosts: QubicCostsEstimationService;

  constructor(
    solanaCosts: SolanaCostsEstimationService,
    qubicCosts: QubicCostsEstimationService,
  ) {
    this.solanaCosts = solanaCosts;
    this.qubicCosts = qubicCosts;
  }

  async estimate(input: SimulationInput): Promise<SimulationOutput> {
    const { networkIn, networkOut } = input;
    const isOutbound = networkIn === NETWORK_SOLANA;

    if (networkIn === networkOut) {
      throw new Error(
        `networkIn and networkOut cannot be the same (${networkIn})`,
      );
    }

    const bridgeFee = this.computeBridgeFee(BigInt(input.amount));
    const relayerFee = await this.getRelayerFee(isOutbound);
    const networkFee = await this.getNetworkFee(isOutbound, input);
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
  }

  private computeBridgeFee(amount: bigint) {
    const oracle = (amount * BPS_FEE) / 10_000n;
    const protocol = (oracle * PROTOCOL_FEE_BPS_OF_BPS) / 10_000n;
    return { oracle, protocol, total: oracle + protocol };
  }

  private async getRelayerFee(isOutbound: boolean): Promise<bigint> {
    return BigInt(
      isOutbound ? MOCK_RELAYER_FEE_QUBIC : MOCK_RELAYER_FEE_SOLANA,
    );
  }

  private async getNetworkFee(
    isOutbound: boolean,
    input: SimulationInput,
  ): Promise<bigint> {
    if (isOutbound) {
      return BigInt(await this.solanaCosts.estimateUserNetworkFee());
    }
    return BigInt(await this.qubicCosts.estimateUserNetworkFee(input));
  }
}

export default fp(
  async function feeEstimationPlugin(fastify: FastifyInstance) {
    const solanaCosts = fastify.getDecorator<SolanaCostsEstimationService>(
      kSolanaCostsEstimation,
    );
    const qubicCosts = fastify.getDecorator<QubicCostsEstimationService>(
      kQubicCostsEstimation,
    );

    fastify.decorate(
      kFeeEstimation,
      new FeeEstimationService(solanaCosts, qubicCosts),
    );
  },
  {
    name: "fee-estimation",
    dependencies: ["solana-costs-estimation", "qubic-costs-estimation"],
  },
);
