import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import { type AppConfig, kConfig } from "../../infra/env.js";
import {
  type UndiciClientService,
  type UndiciClient,
  kUndiciClient,
} from "../../infra/undici-client.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../clients/js/programs/qsBridge.js";
import {
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";

export const BASE_FEE_LAMPORTS = 5_000;
export const OUTBOUND_ORDER_RENT_LAMPORTS = 2_185_440;
export const OUTBOUND_CU = 30_000;

export const kSolanaCostsEstimation = Symbol("solana-costs-estimation");

export type SolanaCostsEstimation = {
  estimateUserNetworkFee(): Promise<bigint>;
};

interface RpcPriorityFeeResponse {
  result: { priorityFeeEstimate: number };
}

export function createSolanaCostsEstimation(
  httpClient: UndiciClient,
  rpcUrl: string,
  accountKeys: string[],
): SolanaCostsEstimation {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const path = url.pathname + url.search;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    return httpClient.postJson<T>(origin, path, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
  }

  async function getPriorityFeeForCu(cu: number): Promise<bigint> {
    const response = await rpc<RpcPriorityFeeResponse>(
      "getPriorityFeeEstimate",
      [{ accountKeys, options: { recommended: true } }],
    );
    const microLamportsPerCu = Math.floor(
      response.result.priorityFeeEstimate,
    );
    const fee =
      (BigInt(microLamportsPerCu) * BigInt(cu) + 999_999n) / 1_000_000n;
    return fee;
  }

  return {
    async estimateUserNetworkFee() {
      const priorityFee = await getPriorityFeeForCu(OUTBOUND_CU);
      return (
        BigInt(BASE_FEE_LAMPORTS) +
        priorityFee +
        BigInt(OUTBOUND_ORDER_RENT_LAMPORTS)
      );
    },
  };
}

export default fp(
  async function solanaCostsEstimationPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const accountKeys = [
      QS_BRIDGE_PROGRAM_ADDRESS,
      config.TOKEN_MINT,
      TOKEN_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ];

    fastify.decorate(
      kSolanaCostsEstimation,
      createSolanaCostsEstimation(
        undiciService.create(),
        config.HELIUS_RPC_URL,
        accountKeys,
      ),
    );
  },
  {
    name: "solana-costs-estimation",
    dependencies: ["env", "undici-client"],
  },
);
