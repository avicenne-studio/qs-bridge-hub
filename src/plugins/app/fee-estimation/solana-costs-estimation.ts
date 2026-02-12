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

export const BASE_FEE_LAMPORTS = 5_000;
export const OUTBOUND_ORDER_RENT_LAMPORTS = 2_185_440;
export const OUTBOUND_CU = 30_000;

export const kSolanaCostsEstimation = Symbol("solana-costs-estimation");

interface RpcPriorityFeeResponse {
  result: { priorityFeeEstimate: number };
}

export class SolanaCostsEstimationService {
  private readonly httpClient: UndiciClient;
  private readonly origin: string;
  private readonly path: string;

  constructor(httpClient: UndiciClient, rpcUrl: string) {
    const url = new URL(rpcUrl);
    this.httpClient = httpClient;
    this.origin = url.origin;
    this.path = url.pathname + url.search;
  }

  async estimateUserNetworkFee(): Promise<number> {
    const priorityFee = await this.getPriorityFeeForCu(OUTBOUND_CU);
    return BASE_FEE_LAMPORTS + priorityFee + OUTBOUND_ORDER_RENT_LAMPORTS;
  }

  private async getPriorityFeeForCu(cu: number): Promise<number> {
    const accountKeys = [
      QS_BRIDGE_PROGRAM_ADDRESS,
      TOKEN_MINT,
      TOKEN_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ];
    const response = await this.rpc<RpcPriorityFeeResponse>(
      "getPriorityFeeEstimate",
      [{ accountKeys, options: { recommended: true } }],
    );
    return Math.ceil((response.result.priorityFeeEstimate * cu) / 1_000_000);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return this.httpClient.postJson<T>(this.origin, this.path, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
  }
}

export default fp(
  async function solanaCostsEstimationPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const service = new SolanaCostsEstimationService(
      undiciService.create(),
      config.HELIUS_RPC_URL,
    );

    fastify.decorate(kSolanaCostsEstimation, service);
  },
  {
    name: "solana-costs-estimation",
    dependencies: ["env", "undici-client"],
  },
);
