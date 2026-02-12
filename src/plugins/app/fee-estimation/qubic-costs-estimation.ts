import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import type {
  ChainCostsEstimation,
  EstimationInput,
} from "./schemas/estimation.js";

export const MOCK_USER_NETWORK_FEE_QUBIC = 1;

export const kQubicCostsEstimation = Symbol("qubic-costs-estimation");

// TODO: Implement real Qubic costs estimation
export class QubicCostsEstimationService implements ChainCostsEstimation {
  async estimateUserNetworkFee(input: EstimationInput): Promise<number> {
    console.log("qubic-costs-estimation: estimateUserNetworkFee", input);
    return MOCK_USER_NETWORK_FEE_QUBIC;
  }
}

export default fp(
  async function qubicCostsEstimationPlugin(fastify: FastifyInstance) {
    fastify.decorate(kQubicCostsEstimation, new QubicCostsEstimationService());
  },
  {
    name: "qubic-costs-estimation",
  },
);
