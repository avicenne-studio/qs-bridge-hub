import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import type {
  ChainCostsEstimation,
  SimulationInput,
} from "./common/schemas/simulation.js";
import { MOCK_USER_NETWORK_FEE_QUBIC } from "./common/mocks.js";

export const kQubicCostsEstimation = Symbol("qubic-costs-estimation");

export class QubicCostsEstimationService implements ChainCostsEstimation {
  // TODO: Implement real Qubic costs estimation
  async estimateUserNetworkFee(input: SimulationInput): Promise<number> {
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
