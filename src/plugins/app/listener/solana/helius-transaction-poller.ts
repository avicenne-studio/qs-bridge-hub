import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../infra/env.js";
import { kConfig } from "../../../infra/env.js";
import type { EventsRepository } from "../../events/events.repository.js";
import { kEventsRepository } from "../../events/events.repository.js";
import { kPoller, type PollerService } from "../../../infra/poller.js";
import {
  kUndiciClient,
  type UndiciClientService,
  UndiciClient,
} from "../../../infra/undici-client.js";
import { createSolanaEventHandlers } from "../../events/solana/solana-events.js";
import { logLinesToEvents, decodeEventBytes } from "./solana-program-logs.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../../clients/js/programs/qsBridge.js";

export type HeliusTransaction = {
  signature: string;
  slot: number;
  meta: {
    err: unknown | null;
    logMessages: string[] | null;
  };
};

type HeliusRpcResponse = {
  result?: { data?: HeliusTransaction[] };
  error?: { message: string };
};

export type HeliusFetcher = (
  signal: AbortSignal,
) => Promise<HeliusTransaction[]>;

export const kHeliusFetcher = Symbol.for("heliusFetcher");

export function createDefaultHeliusFetcher(
  client: UndiciClient,
  rpcUrl: string,
  lookbackSeconds: number,
): HeliusFetcher {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const path = url.pathname + url.search;

  return async (signal: AbortSignal) => {
    const now = Math.floor(Date.now() / 1000);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [
        QS_BRIDGE_PROGRAM_ADDRESS,
        {
          transactionDetails: "full",
          sortOrder: "asc",
          limit: 100,
          maxSupportedTransactionVersion: 0,
          filters: {
            blockTime: { gte: now - lookbackSeconds, lte: now },
            status: "succeeded", //TODO: In PROD we should wait for the transaction to be Finalized and do the same for the WebSocket implementation.
            tokenAccounts: "balanceChanged",
          },
        },
      ],
    };

    const response = await client.postJson<HeliusRpcResponse>(
      origin,
      path,
      body,
      signal,
    );

    if (response.error) {
      throw response.error;
    }

    return response.result?.data ?? [];
  };
}

export function resolveHeliusFetcher(
  instance: FastifyInstance,
  factory: () => HeliusFetcher,
): HeliusFetcher {
  if (instance.hasDecorator(kHeliusFetcher)) {
    return instance.getDecorator<HeliusFetcher>(kHeliusFetcher);
  }
  return factory();
}

export default fp(
  async function heliusTransactionPollerPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);

    if (!config.HELIUS_POLLER_ENABLED) {
      fastify.log.info("Helius poller disabled by configuration");
      return;
    }

    const eventsRepository =
      fastify.getDecorator<EventsRepository>(kEventsRepository);
    const pollerService = fastify.getDecorator<PollerService>(kPoller);
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const {
      handleOutboundEvent,
      handleOverrideOutboundEvent,
      handleInboundEvent,
    } = createSolanaEventHandlers({ eventsRepository, logger: fastify.log });

    const client = undiciService.create();
    const fetcher = resolveHeliusFetcher(fastify, () =>
      createDefaultHeliusFetcher(
        client,
        config.HELIUS_RPC_URL,
        config.HELIUS_POLLER_LOOKBACK_SECONDS,
      ),
    );

    const processTransaction = async (tx: HeliusTransaction) => {
      if (tx.meta.err || !tx.meta.logMessages) return;

      const decodedEvents = logLinesToEvents(tx.meta.logMessages).map(
        decodeEventBytes,
      );
      const txMeta = { signature: tx.signature, slot: tx.slot };

      for (const decoded of decodedEvents) {
        if (!decoded) continue;

        if (decoded.type === "outbound") {
          await handleOutboundEvent(decoded.event, txMeta);
        } else if (decoded.type === "override-outbound") {
          await handleOverrideOutboundEvent(decoded.event, txMeta);
        } else if (decoded.type === "inbound") {
          await handleInboundEvent(decoded.event, txMeta);
        }
      }
    };

    const filterNewTransactions = async (transactions: HeliusTransaction[]) => {
      const signatures = transactions.map((tx) => tx.signature);
      const existingSignatures =
        await eventsRepository.findExistingSignatures(signatures);
      const existingSet = new Set(existingSignatures);
      return transactions.filter((tx) => !existingSet.has(tx.signature));
    };

    const processTransactions = async (transactions: HeliusTransaction[]) => {
      const newTransactions = await filterNewTransactions(transactions);

      if (newTransactions.length > 0) {
        fastify.log.info(
          { added: newTransactions.length, total: transactions.length },
          "Helius poller fetched",
        );
        await Promise.allSettled(
          newTransactions.map((tx) => processTransaction(tx)),
        );
      }
    };

    const poller = pollerService.create<HeliusTransaction[]>({
      servers: [config.HELIUS_RPC_URL],
      fetchOne: (_server, signal) => fetcher(signal),
      onRound: async ([transactions = []]) => {
        await processTransactions(transactions);
      },
      intervalMs: config.HELIUS_POLLER_INTERVAL_MS,
      requestTimeoutMs: config.HELIUS_POLLER_TIMEOUT_MS,
      jitterMs: pollerService.defaults.jitterMs,
    });

    fastify.addHook("onReady", function startPoller() {
      poller.start();
    });
  },
  {
    name: "helius-transaction-poller",
    dependencies: ["env", "events-repository", "polling", "undici-client"],
  },
);
