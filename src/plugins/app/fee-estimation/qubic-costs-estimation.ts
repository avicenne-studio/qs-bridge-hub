import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import type { ChainCostsEstimation } from "./schemas/estimation.js";

export const MOCK_USER_NETWORK_FEE_QUBIC = 1;

export const kQubicCostsEstimation = Symbol("qubic-costs-estimation");

export type QubicCostsEstimation = ChainCostsEstimation;

// TODO: Implement real Qubic costs estimation
export function createQubicCostsEstimation(): QubicCostsEstimation {
  return {
    async estimateUserNetworkFee() {
      return BigInt(MOCK_USER_NETWORK_FEE_QUBIC);
    },
  };
}

export default fp(
  async function qubicCostsEstimationPlugin(fastify: FastifyInstance) {
    fastify.decorate(kQubicCostsEstimation, createQubicCostsEstimation());
  },
  {
    name: "qubic-costs-estimation",
  },
);
