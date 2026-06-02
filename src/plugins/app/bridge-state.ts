import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import { FastifyInstance } from "fastify";
import { kConfig, type AppConfig } from "../infra/env.js";
import {
  kUndiciClient,
  type UndiciClient,
  type UndiciClientService,
} from "../infra/undici-client.js";
import {
  kQubicContractClient,
  type QubicContractClient,
  FUNC_GET_CONFIG,
  decodeGetConfig,
} from "../infra/qubic-contract-client.js";
import { findGlobalStatePda } from "../../clients/js/pdas/globalState.js";
import { getGlobalStateDecoder } from "../../clients/js/accounts/globalState.js";

export const kBridgeState = Symbol("app.bridgeState");

export const BRIDGE_STATE_CACHE_TTL_MS = 30_000;

export type BridgePauseState = { solana: boolean; qubic: boolean };
export type SolanaFeeParams = { bpsFee: bigint; protocolFeeBpsOfBps: bigint };

export type BridgeState = {
  getPauseState(): Promise<BridgePauseState>;
  getSolanaFeeParams(): Promise<SolanaFeeParams>;
};

type SolanaState = { paused: boolean; bpsFee: bigint; protocolFeeBpsOfBps: bigint };
type QubicState = { paused: boolean };

interface GetAccountInfoResponse {
  result: { value: { data: [string, string] } | null };
}

export function createBridgeState(
  httpClient: UndiciClient,
  rpcUrl: string,
  globalStatePda: string,
  qubicClient: QubicContractClient,
  cacheTtlMs = BRIDGE_STATE_CACHE_TTL_MS,
): BridgeState {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const path = url.pathname + url.search;

  function createCache<T>(fetch: () => Promise<T>): () => Promise<T> {
    let cached: T | null = null;
    let cachedAt = 0;
    return async () => {
      const now = Date.now();
      if (cached !== null && now - cachedAt < cacheTtlMs) {
        return cached;
      }
      cached = await fetch();
      cachedAt = now;
      return cached;
    };
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    return httpClient.postJson<T>(origin, path, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
  }

  const getSolana = createCache(async (): Promise<SolanaState> => {
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
    const { paused, bpsFee, protocolFeeBpsOfBps } =
      getGlobalStateDecoder().decode(bytes);
    return {
      paused,
      bpsFee: BigInt(bpsFee),
      protocolFeeBpsOfBps: BigInt(protocolFeeBpsOfBps),
    };
  });

  const getQubic = createCache(async (): Promise<QubicState> => {
    const hex = await qubicClient.queryContractFunction(FUNC_GET_CONFIG, "");
    const { paused } = decodeGetConfig(hex);
    return { paused };
  });

  return {
    async getPauseState() {
      const [solana, qubic] = await Promise.all([getSolana(), getQubic()]);
      return { solana: solana.paused, qubic: qubic.paused };
    },

    async getSolanaFeeParams() {
      const { bpsFee, protocolFeeBpsOfBps } = await getSolana();
      return { bpsFee, protocolFeeBpsOfBps };
    },
  };
}

export default fp(
  async function bridgeStatePlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kBridgeState)) return;

    const config = fastify.getDecorator<AppConfig>(kConfig);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);
    const qubicClient =
      fastify.getDecorator<QubicContractClient>(kQubicContractClient);

    const [globalStatePda] = await findGlobalStatePda();

    fastify.decorate(
      kBridgeState,
      createBridgeState(
        undiciService.create(),
        config.HELIUS_RPC_URL,
        globalStatePda,
        qubicClient,
      ),
    );
  },
  {
    name: "bridge-state",
    dependencies: ["env", "undici-client", "qubic-contract-client"],
  },
);
