import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import { type Address } from "@solana/kit";
import { type AppConfig, kConfig } from "../../infra/env.js";
import {
  type UndiciClientService,
  type UndiciClient,
  kUndiciClient,
} from "../../infra/undici-client.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../clients/js/programs/qsBridge.js";

const TOKEN_MINT =
  "4bbjhGLSYwku6Y44dqwcroRfj2vHCdiHJ9SUmndc4FVg" as Address;
const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

const DEFAULT_ACCOUNT_KEYS: string[] = [
  QS_BRIDGE_PROGRAM_ADDRESS,
  TOKEN_MINT,
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
];

export const BASE_FEE_LAMPORTS = 5_000;
export const OUTBOUND_ORDER_RENT_LAMPORTS = 2_185_440;
export const OUTBOUND_CU = 30_000;

export const kSolanaCostsEstimation = Symbol("solana-costs-estimation");

export type SolanaCostsEstimation = {
  estimateUserNetworkFee(): Promise<number>;
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

  async function getPriorityFeeForCu(cu: number): Promise<number> {
    const response = await rpc<RpcPriorityFeeResponse>(
      "getPriorityFeeEstimate",
      [{ accountKeys, options: { recommended: true } }],
    );
    return Math.ceil((response.result.priorityFeeEstimate * cu) / 1_000_000);
  }

  return {
    async estimateUserNetworkFee() {
      const priorityFee = await getPriorityFeeForCu(OUTBOUND_CU);
      return BASE_FEE_LAMPORTS + priorityFee + OUTBOUND_ORDER_RENT_LAMPORTS;
    },
  };
}

export default fp(
  async function solanaCostsEstimationPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    fastify.decorate(
      kSolanaCostsEstimation,
      createSolanaCostsEstimation(
        undiciService.create(),
        config.HELIUS_RPC_URL,
        DEFAULT_ACCOUNT_KEYS,
      ),
    );
  },
  {
    name: "solana-costs-estimation",
    dependencies: ["env", "undici-client"],
  },
);
