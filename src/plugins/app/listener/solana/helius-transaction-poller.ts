import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../infra/env.js";
import { kConfig } from "../../../infra/env.js";
import type { EventsRepository } from "../../events/events.repository.js";
import { kEventsRepository } from "../../events/events.repository.js";
import { kPoller, type PollerService, sleep } from "../../../infra/poller.js";
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

export type HeliusRpcResult = {
  data: HeliusTransaction[];
  paginationToken: string | null;
};

type HeliusRpcResponse = {
  result?: {
    data?: HeliusTransaction[];
    paginationToken?: string;
  };
  error?: { message: string };
};

export type HeliusFetcherOptions = {
  startTime: number;
  endTime: number;
  paginationToken?: string;
};

export type HeliusFetcher = (
  signal: AbortSignal,
  options: HeliusFetcherOptions,
) => Promise<HeliusRpcResult>;

export const kHeliusFetcher = Symbol.for("heliusFetcher");

const INTERVAL_MULTIPLIERS = [1, 2, 3] as const;
const MAX_TIER = INTERVAL_MULTIPLIERS.length - 1;
const OVERLAP_SECONDS = 60;
const PAGE_RETRY_COUNT = 2;

export function createDefaultHeliusFetcher(
  client: UndiciClient,
  rpcUrl: string,
): HeliusFetcher {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const path = url.pathname + url.search;

  return async (signal, { startTime, endTime, paginationToken }) => {
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
          ...(paginationToken != null && { paginationToken }),
          filters: {
            blockTime: { gte: startTime, lte: endTime },
            status: "succeeded",
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

    return {
      data: response.result?.data ?? [],
      paginationToken: response.result?.paginationToken ?? null,
    };
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

async function fetchPageWithRetry(
  fetcher: HeliusFetcher,
  timeoutMs: number,
  retryDelayMs: number,
  options: HeliusFetcherOptions,
): Promise<HeliusRpcResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PAGE_RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(controller.signal, options);
    } catch (err) {
      lastError = err;
      if (attempt < PAGE_RETRY_COUNT) {
        await sleep(retryDelayMs + Math.random() * retryDelayMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function countProcessedEvents(
  settled: PromiseSettledResult<number>[],
): number {
  return settled.reduce(
    (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
    0,
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
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const {
      handleOutboundEvent,
      handleOverrideOutboundEvent,
      handleInboundEvent,
    } = createSolanaEventHandlers({ eventsRepository, logger: fastify.log });

    const client = undiciService.create();
    const fetcher = resolveHeliusFetcher(fastify, () =>
      createDefaultHeliusFetcher(client, config.HELIUS_RPC_URL),
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

    const deduplicateAndProcess = async (
      transactions: HeliusTransaction[],
    ): Promise<number> => {
      if (transactions.length === 0) return 0;
      const signatures = transactions.map((tx) => tx.signature);
      const existingSignatures =
        await eventsRepository.findExistingSignatures(signatures);
      const existingSet = new Set(existingSignatures);
      const newTx = transactions.filter(
        (tx) => !existingSet.has(tx.signature),
      );
      if (newTx.length > 0) {
        await Promise.allSettled(
          newTx.map((tx) => processTransaction(tx)),
        );
      }
      return newTx.length;
    };

    let intervalTier = 0;
    let lastSuccessEndTime: number | null = null;
    let failedSince: number | null = null;

    function currentIntervalMs(): number {
      return (
        config.HELIUS_POLLER_INTERVAL_MS * INTERVAL_MULTIPLIERS[intervalTier]
      );
    }

    function computeTimeWindow(): { startTime: number; endTime: number } {
      const now = Math.floor(Date.now() / 1000);

      if (failedSince !== null && lastSuccessEndTime !== null) {
        return {
          startTime: lastSuccessEndTime - OVERLAP_SECONDS,
          endTime: now,
        };
      }

      const lookbackSeconds =
        Math.floor(currentIntervalMs() / 1000) + OVERLAP_SECONDS;
      return { startTime: now - lookbackSeconds, endTime: now };
    }

    function onRoundSucceeded(
      endTime: number,
      transactionCount: number,
    ): void {
      lastSuccessEndTime = endTime;
      failedSince = null;
      intervalTier =
        transactionCount > 0 ? 0 : Math.min(intervalTier + 1, MAX_TIER);
    }

    function onRoundFailed(err: unknown): void {
      if (failedSince === null) {
        failedSince = Math.floor(Date.now() / 1000);
      }
      intervalTier = 0;
      fastify.log.error({ err }, "Helius poller round failed");
    }

    function fetchPage(
      timeWindow: HeliusFetcherOptions,
    ): Promise<HeliusRpcResult> {
      return fetchPageWithRetry(
        fetcher,
        config.HELIUS_POLLER_TIMEOUT_MS,
        config.HELIUS_POLLER_RETRY_DELAY_MS,
        timeWindow,
      );
    }

    async function fetchPaginatedPages(
      timeWindow: { startTime: number; endTime: number },
    ): Promise<{ pendingWork: Promise<number>[]; totalTransactions: number }> {
      const pendingWork: Promise<number>[] = [];
      let totalTransactions = 0;

      let page = await fetchPage(timeWindow);
      totalTransactions += page.data.length;

      while (page.paginationToken) {
        pendingWork.push(deduplicateAndProcess(page.data));
        try {
          page = await fetchPage({
            ...timeWindow,
            paginationToken: page.paginationToken,
          });
          totalTransactions += page.data.length;
        } catch (err) {
          await Promise.allSettled(pendingWork);
          throw err;
        }
      }

      pendingWork.push(deduplicateAndProcess(page.data));
      return { pendingWork, totalTransactions };
    }

    async function runRound(): Promise<void> {
      const timeWindow = computeTimeWindow();
      const { pendingWork, totalTransactions } =
        await fetchPaginatedPages(timeWindow);

      const newCount = countProcessedEvents(
        await Promise.allSettled(pendingWork),
      );

      if (totalTransactions > 0) {
        fastify.log.info(
          { added: newCount, total: totalTransactions },
          "Helius poller fetched",
        );
      }

      onRoundSucceeded(timeWindow.endTime, totalTransactions);
    }

    const poller = pollerService.create<void>({
      servers: [config.HELIUS_RPC_URL],
      fetchOne: async () => {
        try {
          await runRound();
        } catch (err) {
          onRoundFailed(err);
        }
      },
      onRound: () => {},
      intervalMs: () => currentIntervalMs(),
      requestTimeoutMs: 0,
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
