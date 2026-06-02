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
import { findGlobalStatePda } from "../../../clients/js/pdas/globalState.js";
import { getGlobalStateDecoder } from "../../../clients/js/accounts/globalState.js";

export const BASE_FEE_LAMPORTS = 5_000;
export const OUTBOUND_ORDER_RENT_LAMPORTS = 2_185_440;
export const OUTBOUND_CU = 30_000;
export const DEFAULT_PRIORITY_FEE_LAMPORTS = 50_000n;

export const kSolanaCostsEstimation = Symbol("solana-costs-estimation");

export type BridgeFeeParams = { bpsFee: bigint; protocolFeeBpsOfBps: bigint };

export type SolanaCostsEstimation = {
  estimateUserNetworkFee(): Promise<bigint>;
  fetchBridgeFeeParams(): Promise<BridgeFeeParams>;
};

interface RpcPriorityFeeResponse {
  result: { priorityFeeEstimate: number };
}

interface GetAccountInfoResponse {
  result: { value: { data: [string, string] } | null };
}

export function createSolanaCostsEstimation(
  httpClient: UndiciClient,
  rpcUrl: string,
  accountKeys: string[],
  globalStatePda: string,
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
      let priorityFee = DEFAULT_PRIORITY_FEE_LAMPORTS;
      try {
        priorityFee = await getPriorityFeeForCu(OUTBOUND_CU);
      } catch {
        // getPriorityFeeEstimate may not be available (e.g. devnet)
      }
      return (
        BigInt(BASE_FEE_LAMPORTS) +
        priorityFee +
        BigInt(OUTBOUND_ORDER_RENT_LAMPORTS)
      );
    },

    async fetchBridgeFeeParams() {
      const response = await rpc<GetAccountInfoResponse>("getAccountInfo", [
        globalStatePda,
        { encoding: "base64" },
      ]);
      if (!response.result.value) {
        throw new Error("Solana GlobalState account not found");
      }
      const bytes = new Uint8Array(
        Buffer.from(response.result.value.data[0], "base64"),
      );
      const { bpsFee, protocolFeeBpsOfBps } =
        getGlobalStateDecoder().decode(bytes);
      return {
        bpsFee: BigInt(bpsFee),
        protocolFeeBpsOfBps: BigInt(protocolFeeBpsOfBps),
      };
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

    const [globalStatePda] = await findGlobalStatePda();

    fastify.decorate(
      kSolanaCostsEstimation,
      createSolanaCostsEstimation(
        undiciService.create(),
        config.HELIUS_RPC_URL,
        accountKeys,
        globalStatePda,
      ),
    );
  },
  {
    name: "solana-costs-estimation",
    dependencies: ["env", "undici-client"],
  },
);
