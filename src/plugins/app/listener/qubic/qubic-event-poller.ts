import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../infra/env.js";
import { kConfig } from "../../../infra/env.js";
import { kPoller, type PollerService } from "../../../infra/poller.js";
import { kEventsRepository, type EventsRepository } from "../../events/events.repository.js";
import {
  type QubicEventPayload,
} from "../../events/qubic/schemas/event.js";
import { createQubicEventHandlers } from "../../events/qubic/qubic-events.js";
import {
  queryContractFunction,
  decodeGetLockedOrders,
  encodePaginationInput,
  FUNC_GET_LOCKED_ORDERS,
} from "../../qubic/contract-client.js";

export type QubicEvent = {
  chain: "qubic";
  type: "lock" | "override-lock" | "unlock";
  nonce: string;
  payload: QubicEventPayload;
  orderHash: string;
};

export type QubicEventFetcher = (signal: AbortSignal) => Promise<QubicEvent[]>;

export const kQubicEventFetcher = Symbol.for("qubicEventFetcher");

const PAGE_LIMIT = 64;

/**
 * Map active LockedOrderEntry values decoded from GetLockedOrders to QubicEvent objects.
 * Uses the order hash (hex) as the stable identifier for deduplication.
 */
function lockedOrdersToEvents(
  entries: ReturnType<typeof decodeGetLockedOrders>["entries"],
): QubicEvent[] {
  return entries
    .filter((entry) => entry.active)
    .map((entry) => ({
      chain: "qubic" as const,
      type: "lock" as const,
      nonce: entry.nonce.toString(),
      orderHash: Buffer.from(entry.orderHash).toString("hex"),
      payload: {
        fromAddress: Buffer.from(entry.sender).toString("hex"),
        toAddress: Buffer.from(entry.toAddress).toString("ascii").replace(/\0+$/u, ""),
        amount: entry.amount.toString(),
        relayerFee: entry.relayerFee.toString(),
        nonce: entry.nonce.toString(),
        orderEra: entry.orderEra.toString(),
      },
    }));
}

export function createDefaultQubicEventFetcher(bobUrl: string): QubicEventFetcher {
  return async () => {
    const hex = await queryContractFunction(
      bobUrl,
      FUNC_GET_LOCKED_ORDERS,
      encodePaginationInput(0, PAGE_LIMIT),
    );
    const { entries } = decodeGetLockedOrders(hex);
    return lockedOrdersToEvents(entries);
  };
}

export function resolveQubicEventFetcher(
  instance: FastifyInstance,
  factory: () => QubicEventFetcher,
): QubicEventFetcher {
  if (instance.hasDecorator(kQubicEventFetcher)) {
    return instance.getDecorator<QubicEventFetcher>(kQubicEventFetcher);
  }
  return factory();
}

export default fp(
  async function qubicEventPollerPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);

    if (!config.QUBIC_POLLER_ENABLED) {
      fastify.log.info("Qubic poller disabled by configuration");
      return;
    }

    const eventsRepository =
      fastify.getDecorator<EventsRepository>(kEventsRepository);
    const pollerService = fastify.getDecorator<PollerService>(kPoller);

    const { handleQubicEvent } =
      createQubicEventHandlers({ eventsRepository, logger: fastify.log });

    const fetcher = resolveQubicEventFetcher(fastify, () =>
      createDefaultQubicEventFetcher(config.QUBIC_RPC_URL),
    );

    const filterNewEvents = async (items: QubicEvent[]) => {
      const signatures = items.map((event) => event.orderHash);
      const existing = await eventsRepository.findExistingSignatures(signatures);
      const existingSet = new Set(existing);
      return items.filter((event) => !existingSet.has(event.orderHash));
    };

    const poller = pollerService.create<QubicEvent[]>({
      servers: [config.QUBIC_RPC_URL],
      fetchOne: async (_server, signal) => {
        try {
          return await fetcher(signal);
        } catch (err) {
          fastify.log.warn({ err }, "qubic events poll failed");
          return [] as QubicEvent[];
        }
      },
      onRound: async ([events = []]) => {
        const newEvents = await filterNewEvents(events);
        if (newEvents.length === 0) return;
        await Promise.allSettled(newEvents.map((event) => handleQubicEvent(event)));
      },
      logger: fastify.log,
      intervalMs: config.QUBIC_POLLER_INTERVAL_MS,
      requestTimeoutMs: config.QUBIC_POLLER_TIMEOUT_MS,
      jitterMs: pollerService.defaults.jitterMs,
    });

    fastify.addHook("onReady", function startPoller() {
      poller.start();
    });
  },
  {
    name: "qubic-event-poller",
    dependencies: [
      "env",
      "events-repository",
      "polling",
    ],
  },
);
