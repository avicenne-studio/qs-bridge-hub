import fp from "fastify-plugin";
import { type FastifyInstance } from "fastify";
import { type Address } from "@solana/kit";
import { type AppConfig, kConfig } from "../infra/env.js";
import {
  type UndiciClientService,
  type UndiciClient,
  kUndiciClient,
} from "../infra/undici-client.js";
import { findGlobalStatePda } from "../../clients/js/pdas/globalState.js";
import { getGlobalStateDecoder } from "../../clients/js/accounts/globalState.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../clients/js/programs/qsBridge.js";
import {
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  BASE_FEE_LAMPORTS,
  ATA_RENT_LAMPORTS,
  INBOUND_ORDER_RENT_LAMPORTS,
  INBOUND_CU,
  findAssociatedTokenAddress,
} from "./common/solana.js";

export const kCostsEstimation = Symbol("costs-estimation");

interface RpcAccountInfoResponse {
  result: {
    value: { data: [string, string] } | null;
  };
}

interface RpcPriorityFeeResponse {
  result: { priorityFeeEstimate: number };
}

interface OnChainState {
  tokenMint: Address;
  globalStatePda: string;
  fixedAccountKeys: string[];
}

export class CostsEstimationService {
  private cachedState: OnChainState | null = null;
  private readonly httpClient: UndiciClient;
  private readonly origin: string;
  private readonly path: string;

  constructor(httpClient: UndiciClient, rpcUrl: string) {
    const url = new URL(rpcUrl);
    this.httpClient = httpClient;
    this.origin = url.origin;
    this.path = url.pathname + url.search;
  }

  async estimateInboundCost(recipientAddress: string): Promise<number> {
    const state = await this.loadOnChainState();
    const recipient = recipientAddress as Address;
    const recipientAta = await findAssociatedTokenAddress(
      recipient,
      state.tokenMint,
    );

    const ataResponse = await this.rpc<RpcAccountInfoResponse>(
      "getAccountInfo",
      [recipientAta, { encoding: "base64" }],
    );
    const ataExists = ataResponse.result.value !== null;

    const feeResponse = await this.rpc<RpcPriorityFeeResponse>(
      "getPriorityFeeEstimate",
      [{ accountKeys: state.fixedAccountKeys, options: { recommended: true } }],
    );

    const microLamportsPerCU = feeResponse.result.priorityFeeEstimate;
    const priorityFee = Math.ceil(
      (microLamportsPerCU * INBOUND_CU) / 1_000_000,
    );
    const rentAta = ataExists ? 0 : ATA_RENT_LAMPORTS;

    return BASE_FEE_LAMPORTS + priorityFee + rentAta + INBOUND_ORDER_RENT_LAMPORTS;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return this.httpClient.postJson<T>(this.origin, this.path, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
  }

  private async loadOnChainState(): Promise<OnChainState> {
    if (this.cachedState) return this.cachedState;

    const [globalStatePda] = await findGlobalStatePda();

    const gsResponse = await this.rpc<RpcAccountInfoResponse>(
      "getAccountInfo",
      [globalStatePda, { encoding: "base64" }],
    );

    if (!gsResponse.result.value) {
      throw new Error(
        "costs-estimation: globalState account not found on-chain",
      );
    }

    const gsBytes = Buffer.from(gsResponse.result.value.data[0], "base64");
    const globalState = getGlobalStateDecoder().decode(gsBytes);

    this.cachedState = {
      tokenMint: globalState.tokenMint,
      globalStatePda,
      fixedAccountKeys: [
        QS_BRIDGE_PROGRAM_ADDRESS,
        globalStatePda,
        globalState.tokenMint,
        TOKEN_PROGRAM_ADDRESS,
        SYSTEM_PROGRAM_ADDRESS,
        ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      ],
    };

    return this.cachedState;
  }
}

export default fp(
  async function costsEstimationPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const service = new CostsEstimationService(
      undiciService.create(),
      config.HELIUS_RPC_URL,
    );

    fastify.decorate(kCostsEstimation, service);
  },
  {
    name: "costs-estimation",
    dependencies: ["env", "undici-client"],
  },
);
