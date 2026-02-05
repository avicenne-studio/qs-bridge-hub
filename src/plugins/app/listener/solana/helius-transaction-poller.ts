import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../infra/env.js";
import { kConfig } from "../../../infra/env.js";
import type { EventsRepository } from "../../events/events.repository.js";
import { kEventsRepository } from "../../events/events.repository.js";
import {
  kPoller,
  type PollerService,
} from "../../../infra/poller.js";
import {
  kUndiciClient,
  type UndiciClientService,
  UndiciClient,
} from "../../../infra/undici-client.js";
import { createSolanaEventHandlers } from "./solana-events.js";
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

export type HeliusFetcher = (signal: AbortSignal) => Promise<HeliusTransaction[]>;

export type HeliusFetcherOwner = {
  heliusFetcher?: HeliusFetcher;
  parent?: HeliusFetcherOwner;
};

export function createDefaultHeliusFetcher(
  client: UndiciClient,
  rpcUrl: string,
  lookbackSeconds: number
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
      signal
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.result?.data ?? [];
  };
}

export function resolveHeliusFetcher(
  instance: HeliusFetcherOwner,
  defaultFetcher: HeliusFetcher
): HeliusFetcher {
  return (
    instance.heliusFetcher ?? instance.parent?.heliusFetcher ?? defaultFetcher
  );
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
    const undiciService = fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const { handleOutboundEvent, handleOverrideOutboundEvent } =
      createSolanaEventHandlers({ eventsRepository, logger: fastify.log });

    const client = undiciService.create();
    const defaultFetcher = createDefaultHeliusFetcher(
      client,
      config.HELIUS_RPC_URL,
      config.HELIUS_POLLER_LOOKBACK_SECONDS
    );
    const fetcher = resolveHeliusFetcher(
      fastify as HeliusFetcherOwner,
      defaultFetcher
    );

    const processedSignatures = new Set<string>();

    const extractDecodedEvents = (logMessages: string[]) => {
      return logLinesToEvents(logMessages)
        .map(decodeEventBytes)
        .filter(
          (decoded): decoded is NonNullable<typeof decoded> =>
            decoded !== null && decoded.type !== "inbound"
        );
    };

    const handleEvent = async (
      decoded: NonNullable<ReturnType<typeof decodeEventBytes>>,
      txMeta: { signature: string; slot: number }
    ) => {
      if (decoded.type === "outbound") {
        await handleOutboundEvent(decoded.event, txMeta);
      } else {
        await handleOverrideOutboundEvent(decoded.event, txMeta);
      }
    };

    const processTransaction = async (tx: HeliusTransaction) => {
      if (tx.meta.err || !tx.meta.logMessages) return;

      const decodedEvents = extractDecodedEvents(tx.meta.logMessages);
      const txMeta = { signature: tx.signature, slot: tx.slot };

      for (const decoded of decodedEvents) {
        try {
          await handleEvent(decoded, txMeta);
        } catch (err) {
          fastify.log.error({ err, sig: tx.signature }, "Helius event error");
        }
      }
    };

    const filterNewTransactions = (transactions: HeliusTransaction[]) => {
      const newTransactions = transactions.filter(tx => !processedSignatures.has(tx.signature));
      
      processedSignatures.clear();
      transactions.forEach(tx => processedSignatures.add(tx.signature));
      
      return newTransactions;
    };

    const processTransactions = async (transactions: HeliusTransaction[]) => {
      const newTransactions = filterNewTransactions(transactions);

      if (newTransactions.length > 0) {
        fastify.log.info(
          { count: newTransactions.length, total: transactions.length },
          "Helius poller fetched"
        );
        await Promise.allSettled(newTransactions.map(tx => processTransaction(tx)));
      }
    };

    const poller = pollerService.create<HeliusTransaction[]>({
      servers: [config.HELIUS_RPC_URL],
      fetchOne: (_server, signal) => fetcher(signal),
      onRound: async (responses) => {
        const transactions = responses[0] ?? [];
        await processTransactions(transactions);
      },
      intervalMs: config.HELIUS_POLLER_INTERVAL_MS,
      requestTimeoutMs: config.HELIUS_POLLER_TIMEOUT_MS,
      jitterMs: 0,
    });

    fastify.addHook("onReady", function startPoller() {
      fastify.log.info("Helius poller started");
      poller.start();
    });
  },
  {
    name: "helius-transaction-poller",
    dependencies: ["env", "events-repository", "polling", "undici-client"],
  }
);
