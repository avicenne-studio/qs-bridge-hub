import type { FastifyBaseLogger } from "fastify";
import type { EventsRepository } from "../events.repository.js";
import type { QubicEventPayload } from "./schemas/event.js";

export type QubicEvent = {
  chain: "qubic";
  type: "lock" | "override-lock" | "unlock";
  nonce: string;
  payload: QubicEventPayload;
  trxHash?: string;
};

type Logger = FastifyBaseLogger;

type QubicEventDependencies = {
  eventsRepository: EventsRepository;
  logger: Logger;
};

export function createQubicEventHandlers(deps: QubicEventDependencies) {
  const { eventsRepository, logger } = deps;

  const handleQubicEvent = async (event: QubicEvent) => {
    if (!event.trxHash) {
      logger.warn("Qubic event missing transaction hash");
      return;
    }
    await eventsRepository.create({
      signature: event.trxHash,
      slot: null,
      chain: "qubic",
      type: event.type,
      nonce: event.nonce,
      payload: event.payload,
    });
    logger.info({ signature: event.trxHash }, "Qubic event stored");
  };

  return { handleQubicEvent };
}
