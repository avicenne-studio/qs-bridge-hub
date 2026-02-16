import { type SolanaEventPayload } from "../solana/schemas/event.js";
import { type QubicEventPayload } from "../qubic/schemas/event.js";

export type EventPayload = SolanaEventPayload | QubicEventPayload;
