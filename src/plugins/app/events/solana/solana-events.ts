import type { FastifyBaseLogger } from "fastify";
import type { OutboundEvent } from "../../../../clients/js/types/outboundEvent.js";
import type { OverrideOutboundEvent } from "../../../../clients/js/types/overrideOutboundEvent.js";
import type { InboundEvent } from "../../../../clients/js/types/inboundEvent.js";
import { bytesToHex } from "./bytes.js";
import type { EventsRepository } from "../events.repository.js";

type Logger = FastifyBaseLogger;

type SolanaEventDependencies = {
  eventsRepository: EventsRepository;
  logger: Logger;
};

type SolanaEventMeta = {
  signature?: string;
  slot?: number;
};

function buildOutboundPayload(event: OutboundEvent) {
  return {
    networkIn: event.networkIn,
    networkOut: event.networkOut,
    tokenIn: bytesToHex(event.tokenIn),
    tokenOut: bytesToHex(event.tokenOut),
    fromAddress: bytesToHex(event.fromAddress),
    toAddress: bytesToHex(event.toAddress),
    amount: event.amount.toString(),
    relayerFee: event.relayerFee.toString(),
    nonce: bytesToHex(event.nonce),
  };
}

function buildOverridePayload(event: OverrideOutboundEvent) {
  return {
    toAddress: bytesToHex(event.toAddress),
    relayerFee: event.relayerFee.toString(),
    nonce: bytesToHex(event.nonce),
  };
}

function buildInboundPayload(event: InboundEvent) {
  return {
    networkIn: event.networkIn,
    networkOut: event.networkOut,
    tokenIn: bytesToHex(event.tokenIn),
    tokenOut: bytesToHex(event.tokenOut),
    fromAddress: bytesToHex(event.fromAddress),
    toAddress: bytesToHex(event.toAddress),
    amount: event.amount.toString(),
    relayerFee: event.relayerFee.toString(),
    nonce: bytesToHex(event.nonce),
  };
}

export function createSolanaEventHandlers(deps: SolanaEventDependencies) {
  const { eventsRepository, logger } = deps;

  const handleOutboundEvent = async (
    event: OutboundEvent,
    meta?: SolanaEventMeta
  ) => {
    if (!meta?.signature) {
      logger.warn("Solana outbound event missing transaction signature");
      return;
    }
    const payload = buildOutboundPayload(event);
    await eventsRepository.create({
      signature: meta.signature,
      slot: meta.slot ?? null,
      chain: "solana",
      type: "outbound",
      nonce: payload.nonce,
      payload,
    });
    logger.info(
      { signature: meta.signature, slot: meta.slot },
      "Solana outbound event stored"
    );
  };

  const handleOverrideOutboundEvent = async (
    event: OverrideOutboundEvent,
    meta?: SolanaEventMeta
  ) => {
    if (!meta?.signature) {
      logger.warn("Solana override event missing transaction signature");
      return;
    }
    const payload = buildOverridePayload(event);
    await eventsRepository.create({
      signature: meta.signature,
      slot: meta.slot ?? null,
      chain: "solana",
      type: "override-outbound",
      nonce: payload.nonce,
      payload,
    });
    logger.info(
      { signature: meta.signature, slot: meta.slot },
      "Solana override event stored"
    );
  };

  const handleInboundEvent = async (
    event: InboundEvent,
    meta?: SolanaEventMeta
  ) => {
    if (!meta?.signature) {
      logger.warn("Solana inbound event missing transaction signature");
      return;
    }
    const payload = buildInboundPayload(event);
    await eventsRepository.create({
      signature: meta.signature,
      slot: meta.slot ?? null,
      chain: "solana",
      type: "inbound",
      nonce: payload.nonce,
      payload,
    });
    logger.info(
      { signature: meta.signature, slot: meta.slot },
      "Solana inbound event stored"
    );
  };

  return {
    handleOutboundEvent,
    handleOverrideOutboundEvent,
    handleInboundEvent,
  };
}
