import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { AppConfig } from "../../../infra/env.js";
import { kConfig } from "../../../infra/env.js";
import { kPoller, type PollerService } from "../../../infra/poller.js";
import {
  kUndiciClient,
  type UndiciClientService,
  UndiciClient,
} from "../../../infra/undici-client.js";
import { kEventsRepository, type EventsRepository } from "../../events/events.repository.js";
import {
  QubicEventPayloadSchema,
  QubicEventTypeSchema,
} from "../../events/qubic/schemas/event.js";
import { type QubicEventPayload } from "../../events/qubic/schemas/event.js";
import { createQubicEventHandlers } from "../../events/qubic/qubic-events.js";
import { formatFirstError, kValidation, type ValidationService } from "../../common/validator.js";

export type QubicEvent = {
  chain: "qubic";
  type: "lock" | "override-lock";
  nonce: string;
  payload: QubicEventPayload;
  trxHash?: string;
  orderHash?: string;
  createdAt?: string;
};

type QubicEventsPayload = QubicEvent[] | { data: QubicEvent[] };

export type QubicEventFetcher = (signal: AbortSignal) => Promise<QubicEvent[]>;

export const kQubicEventFetcher = Symbol.for("qubicEventFetcher");

const QubicEventSchema = Type.Object({
  chain: Type.Literal("qubic"),
  type: QubicEventTypeSchema,
  nonce: Type.String(),
  payload: QubicEventPayloadSchema,
  trxHash: Type.Optional(Type.String()),
  orderHash: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
});

const QubicEventsPayloadSchema = Type.Union([
  Type.Array(QubicEventSchema),
  Type.Object({ data: Type.Array(QubicEventSchema) }),
]);

function normalizeEventsPayload(
  payload: unknown,
  validation: ValidationService,
  fastify: FastifyInstance,
) {
  if (!validation.isValid<QubicEventsPayload>(QubicEventsPayloadSchema, payload)) {
    const payloadType = Array.isArray(payload) ? "array" : typeof payload;
    const payloadKeys =
      payload && typeof payload === "object"
        ? Object.keys(payload as Record<string, unknown>).slice(0, 8)
        : [];
    const reason = formatFirstError(QubicEventsPayloadSchema, payload);
    fastify.log.warn(
      { reason, payloadType, payloadKeys },
      "qubic events poll returned invalid payload",
    );
    return [] as QubicEvent[];
  }

  return Array.isArray(payload) ? payload : payload.data;
}

export function createDefaultQubicEventFetcher(
  client: UndiciClient,
  rpcUrl: string,
): QubicEventFetcher {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const path = url.pathname + url.search;

  return async (signal: AbortSignal) => {
    return client.getJson<QubicEventsPayload>(origin, path, signal).then(
      (payload) => (Array.isArray(payload) ? payload : payload.data),
    );
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
    const undiciService =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);
    const validation = fastify.getDecorator<ValidationService>(kValidation);

    const { handleQubicEvent } =
      createQubicEventHandlers({ eventsRepository, logger: fastify.log });

    const client = undiciService.create();
    const fetcher = resolveQubicEventFetcher(fastify, () =>
      createDefaultQubicEventFetcher(client, config.QUBIC_RPC_URL),
    );

    const filterNewEvents = async (items: QubicEvent[]) => {
      const signatures = items.map((event) => event.trxHash ?? "");
      const existing = await eventsRepository.findExistingSignatures(signatures);
      const existingSet = new Set(existing);
      return items.filter(
        (event) => event.trxHash && !existingSet.has(event.trxHash),
      );
    };

    const poller = pollerService.create<QubicEvent[]>({
      servers: [config.QUBIC_RPC_URL],
      fetchOne: async (_server, signal) => {
        try {
          const payload = await fetcher(signal);
          return normalizeEventsPayload(payload, validation, fastify);
        } catch (err) {
          fastify.log.warn({ err }, "qubic events poll failed");
          return [] as QubicEvent[];
        }
      },
      onRound: async ([events = []]) => {
        const newEvents = await filterNewEvents(events);
        if (newEvents.length === 0) {
          return;
        }

        await Promise.allSettled(
          newEvents.map((event) => handleQubicEvent(event)),
        );
      },
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
      "undici-client",
      "validation",
    ],
  },
);
