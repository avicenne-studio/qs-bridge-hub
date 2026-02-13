import { Static, Type } from "@sinclair/typebox";
import { createStoredEventSchema } from "./base.js";
import {
  SolanaEventChainSchema,
  SolanaEventPayloadSchema,
  SolanaEventTypeSchema,
} from "../solana/schemas/event.js";
import {
  QubicEventChainSchema,
  QubicEventPayloadSchema,
  QubicEventTypeSchema,
} from "../qubic/schemas/event.js";

export const EventChainSchema = Type.Union([
  SolanaEventChainSchema,
  QubicEventChainSchema,
]);

export const EventTypeSchema = Type.Union([
  SolanaEventTypeSchema,
  QubicEventTypeSchema,
]);

export const EventPayloadSchema = Type.Union([
  SolanaEventPayloadSchema,
  QubicEventPayloadSchema,
]);

export const StoredEventSchema = createStoredEventSchema({
  chain: EventChainSchema,
  type: EventTypeSchema,
  nonce: Type.String(),
  payload: EventPayloadSchema,
});

export type StoredEvent = Static<typeof StoredEventSchema>;
