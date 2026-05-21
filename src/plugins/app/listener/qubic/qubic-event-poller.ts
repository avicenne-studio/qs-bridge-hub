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
  kQubicContractClient,
  type QubicContractClient,
  type LockedOrder,
} from "../../../infra/qubic-contract-client.js";

export type QubicEvent = {
  chain: "qubic";
  type: "lock" | "override-lock" | "unlock";
  nonce: string;
  payload: QubicEventPayload;
  orderHash: string;
};

export type QubicEventFetcher = (signal: AbortSignal) => Promise<QubicEvent[]>;

export const kQubicEventFetcher = Symbol.for("qubicEventFetcher");

const UNKNOWN_UNLOCK_ADDRESS = "0".repeat(64);

function lockOrderToQubicEvent(
  type: "lock" | "override-lock",
  order: LockedOrder,
): QubicEvent {
  return {
    chain: "qubic",
    type,
    nonce: order.nonce.toString(),
    orderHash: Buffer.from(order.orderHash).toString("hex"),
    payload: {
      fromAddress: Buffer.from(order.sender).toString("hex"),
      toAddress: Buffer.from(order.toAddress).toString("ascii").replace(/\0+$/u, ""),
      amount: order.amount.toString(),
      relayerFee: order.relayerFee.toString(),
      nonce: order.nonce.toString(),
      orderEra: order.orderEra.toString(),
    },
  };
}

function unlockOrderHashToQubicEvent(orderHash: string): QubicEvent {
  return {
    chain: "qubic",
    type: "unlock",
    nonce: "",
    orderHash,
    payload: {
      toAddress: UNKNOWN_UNLOCK_ADDRESS,
      amount: "0",
      nonce: "",
    },
  };
}

function getLockIdentity(order: LockedOrder): string {
  return [
    Buffer.from(order.sender).toString("hex"),
    order.nonce.toString(),
    order.orderEra.toString(),
  ].join(":");
}

export function createDefaultQubicEventFetcher(
  contractClient: QubicContractClient,
  opts: { syncToHeadOnStart?: boolean } = {},
): QubicEventFetcher {
  const syncToHeadOnStart = opts.syncToHeadOnStart === true;
  let isInitialized = false;
  let previousLocksByHash = new Map<string, LockedOrder>();
  let previousLockIdentityToHash = new Map<string, string>();
  let previousFilledOrderHashes = new Set<string>();

  return async () => {
    const [lockedOrders, filledOrderHashes] = await Promise.all([
      contractClient.listLockedOrders(),
      contractClient.listFilledOrderHashes(),
    ]);
    const currentLocksByHash = new Map<string, LockedOrder>();
    const currentLockIdentityToHash = new Map<string, string>();
    for (const order of lockedOrders) {
      if (!order.active) continue;
      const orderHash = Buffer.from(order.orderHash).toString("hex");
      currentLocksByHash.set(orderHash, order);
      currentLockIdentityToHash.set(getLockIdentity(order), orderHash);
    }

    const currentFilledOrderHashes = new Set(
      filledOrderHashes.map((hash) => Buffer.from(hash).toString("hex")),
    );

    if (syncToHeadOnStart && !isInitialized) {
      previousLocksByHash = currentLocksByHash;
      previousLockIdentityToHash = currentLockIdentityToHash;
      previousFilledOrderHashes = currentFilledOrderHashes;
      isInitialized = true;
      return [];
    }
    isInitialized = true;

    const events: QubicEvent[] = [];

    for (const [orderHash, order] of currentLocksByHash.entries()) {
      if (previousLocksByHash.has(orderHash)) continue;
      const previousHashForIdentity = previousLockIdentityToHash.get(
        getLockIdentity(order),
      );
      const type =
        previousHashForIdentity !== undefined && previousHashForIdentity !== orderHash
          ? "override-lock"
          : "lock";
      events.push(lockOrderToQubicEvent(type, order));
    }

    for (const orderHash of currentFilledOrderHashes) {
      if (!previousFilledOrderHashes.has(orderHash)) {
        events.push(unlockOrderHashToQubicEvent(orderHash));
      }
    }

    previousLocksByHash = currentLocksByHash;
    previousLockIdentityToHash = currentLockIdentityToHash;
    previousFilledOrderHashes = currentFilledOrderHashes;

    return events;
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

    const eventsRepository = fastify.getDecorator<EventsRepository>(kEventsRepository);
    const pollerService = fastify.getDecorator<PollerService>(kPoller);
    const contractClient = fastify.getDecorator<QubicContractClient>(kQubicContractClient);

    const { handleQubicEvent } =
      createQubicEventHandlers({ eventsRepository, logger: fastify.log });

    const fetcher = resolveQubicEventFetcher(fastify, () =>
      createDefaultQubicEventFetcher(contractClient, {
        syncToHeadOnStart: config.QUBIC_POLLER_SYNC_TO_HEAD_ON_START,
      }),
    );

    const poller = pollerService.create<QubicEvent[]>({
      servers: [config.QUBIC_BOB_URL],
      fetchOne: async (_server, signal) => {
        try {
          return await fetcher(signal);
        } catch (err) {
          fastify.log.warn({ err }, "qubic events poll failed");
          return [] as QubicEvent[];
        }
      },
      onRound: async ([events = []]) => {
        if (events.length === 0) return;
        await Promise.allSettled(events.map((event) => handleQubicEvent(event)));
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
      "qubic-contract-client",
    ],
  },
);
