import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import { type AppConfig, kConfig } from "../../infra/env.js";
import type { ChainCostsEstimation } from "./schemas/estimation.js";

export const kQubicCostsEstimation = Symbol("qubic-costs-estimation");

export type QubicCostsEstimation = ChainCostsEstimation;

export function createQubicCostsEstimation(
  invocationReward: number,
): QubicCostsEstimation {
  return {
    async estimateUserNetworkFee() {
      return BigInt(invocationReward);
    },
  };
}

export default fp(
  async function qubicCostsEstimationPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    fastify.decorate(
      kQubicCostsEstimation,
      createQubicCostsEstimation(config.QUBIC_INVOCATION_REWARD),
    );
  },
  {
    name: "qubic-costs-estimation",
    dependencies: ["env"],
  },
);
