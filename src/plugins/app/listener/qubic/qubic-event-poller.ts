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
  type QubicLockLogData,
  type QubicUnlockLogData,
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

const BATCH_SIZE = 200;

function lockLogToQubicEvent(type: "lock" | "override-lock", data: QubicLockLogData): QubicEvent {
  return {
    chain: "qubic",
    type,
    nonce: data.nonce.toString(),
    orderHash: Buffer.from(data.orderHash).toString("hex"),
    payload: {
      fromAddress: Buffer.from(data.fromAddress).toString("hex"),
      toAddress: Buffer.from(data.toAddress).toString("ascii").replace(/\0+$/u, ""),
      amount: data.amount.toString(),
      relayerFee: data.relayerFee.toString(),
      nonce: data.nonce.toString(),
      orderEra: data.orderEra.toString(),
    },
  };
}

// Unlock logs carry no nonce — recover it from the lock event seen this session.
// For cross-epoch orders (lock in a prior epoch), nonce falls back to "".
function unlockLogToQubicEvent(data: QubicUnlockLogData, nonce: string): QubicEvent {
  return {
    chain: "qubic",
    type: "unlock",
    nonce,
    orderHash: Buffer.from(data.orderHash).toString("hex"),
    payload: {
      toAddress: Buffer.from(data.toAddress).toString("hex"),
      amount: data.amount.toString(),
      nonce,
    },
  };
}

export function createDefaultQubicEventFetcher(contractClient: QubicContractClient): QubicEventFetcher {
  // Maps orderHash hex → nonce string; populated from lock events seen this session
  // so that unlock events (which carry no nonce) can be reconstructed correctly.
  const orderHashToNonce = new Map<string, string>();
  let lastLogId = -1;
  let lastEpoch = -1;

  return async () => {
    const { epoch } = await contractClient.getBobStatus();
    if (epoch !== lastEpoch) {
      lastEpoch = epoch;
      lastLogId = -1;
    }

    const events: QubicEvent[] = [];
    while (true) {
      const entries = await contractClient.findEvents(epoch, lastLogId + 1, lastLogId + BATCH_SIZE);
      for (const entry of entries) {
        if (!entry.data.success) continue;
        if (entry.type === "lock" || entry.type === "override-lock") {
          const event = lockLogToQubicEvent(entry.type, entry.data);
          orderHashToNonce.set(event.orderHash, event.nonce);
          events.push(event);
        } else if (entry.type === "unlock") {
          const orderHashHex = Buffer.from(entry.data.orderHash).toString("hex");
          events.push(unlockLogToQubicEvent(entry.data, orderHashToNonce.get(orderHashHex) ?? ""));
        }
      }
      if (entries.length === 0) break;
      lastLogId = Math.max(...entries.map((e) => e.logId));
      if (entries.length < BATCH_SIZE) break;
    }
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
      createDefaultQubicEventFetcher(contractClient),
    );

    const filterNewLockEvents = async (items: QubicEvent[]) => {
      const signatures = items.map((event) => event.orderHash);
      const existing = await eventsRepository.findExistingSignatures(signatures);
      const existingSet = new Set(existing);
      return items.filter((event) => !existingSet.has(event.orderHash));
    };

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
        // Unlock events share orderHash with lock events — must not go through filterNewLockEvents.
        // The cursor in createDefaultQubicEventFetcher prevents re-emitting within a session;
        // on restart the DB onConflict constraint deduplicates any replayed unlocks.
        const lockEvents = events.filter((e) => e.type === "lock" || e.type === "override-lock");
        const unlockEvents = events.filter((e) => e.type === "unlock");
        const newLockEvents = await filterNewLockEvents(lockEvents);
        const allNew = [...newLockEvents, ...unlockEvents];
        if (allNew.length === 0) return;
        await Promise.allSettled(allNew.map((event) => handleQubicEvent(event)));
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
