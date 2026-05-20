import type { FastifyBaseLogger } from "fastify";
import type { EventsRepository } from "../events.repository.js";
import type { QubicEventPayload } from "./schemas/event.js";

export type QubicEvent = {
  chain: "qubic";
  type: "lock" | "override-lock" | "unlock";
  nonce: string;
  payload: QubicEventPayload;
  orderHash: string;
};

type Logger = FastifyBaseLogger;

type QubicEventDependencies = {
  eventsRepository: EventsRepository;
  logger: Logger;
};

export function createQubicEventHandlers(deps: QubicEventDependencies) {
  const { eventsRepository, logger } = deps;

  const handleQubicEvent = async (event: QubicEvent) => {
    await eventsRepository.create({
      signature: event.orderHash,
      slot: null,
      chain: "qubic",
      type: event.type,
      nonce: event.nonce,
      payload: event.payload,
    });
    logger.info({ signature: event.orderHash }, "Qubic event stored");
  };

  return { handleQubicEvent };
}
