import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kKnex, type KnexAccessor } from "../../infra/knex.js";
import {
  type SolanaEventPayload,
  type StoredEvent,
} from "./schemas/event.js";

export const EVENTS_TABLE_NAME = "events";
export const kEventsRepository = Symbol("app.eventsRepository");

type PersistedEvent = {
  id: number;
  signature: string;
  slot: number | null;
  chain: string;
  type: string;
  nonce: string;
  payload: string;
  created_at: string;
};

export type NewEvent = {
  signature: string;
  slot: number | null;
  chain: "solana";
  type: "outbound" | "override-outbound";
  nonce: string;
  payload: SolanaEventPayload;
};

export type EventsRepository = {
  create(event: NewEvent): Promise<StoredEvent | null>;
  listAfter(afterId: number, limit: number): Promise<StoredEvent[]>;
  findExistingSignatures(signatures: string[]): Promise<string[]>;
};

function normalizeEvent(row: PersistedEvent): StoredEvent {
  return {
    id: row.id,
    signature: row.signature,
    slot: row.slot ?? undefined,
    chain: row.chain as StoredEvent["chain"],
    type: row.type as StoredEvent["type"],
    nonce: row.nonce,
    payload: JSON.parse(row.payload) as SolanaEventPayload,
    createdAt: row.created_at,
  };
}

function createRepository(fastify: FastifyInstance): EventsRepository {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async create(event: NewEvent) {
      const payload = JSON.stringify(event.payload);
      const existing = await knex<PersistedEvent>(EVENTS_TABLE_NAME)
        .select("id")
        .where({
          signature: event.signature,
          type: event.type,
          nonce: event.nonce,
        })
        .first();
      if (existing) {
        return null;
      }
      const inserted = await knex<PersistedEvent>(EVENTS_TABLE_NAME)
        .insert({
          signature: event.signature,
          slot: event.slot,
          chain: event.chain,
          type: event.type,
          nonce: event.nonce,
          payload,
        })
        .onConflict(["signature", "type", "nonce"])
        .ignore();

      const insertedId = (inserted as number[])[0];
      const row = await knex<PersistedEvent>(EVENTS_TABLE_NAME)
        .select("*")
        .where({ id: insertedId })
        .first();
      return normalizeEvent(row as PersistedEvent);
    },

    async listAfter(afterId: number, limit: number) {
      const rows = await knex<PersistedEvent>(EVENTS_TABLE_NAME)
        .select("*")
        .where("id", ">", afterId)
        .orderBy("id", "asc")
        .limit(limit);
      return rows.map((row) => normalizeEvent(row));
    },

    async findExistingSignatures(signatures: string[]) {
      if (signatures.length === 0) return [];
      const rows = await knex<PersistedEvent>(EVENTS_TABLE_NAME)
        .select("signature")
        .whereIn("signature", signatures)
        .groupBy("signature");
      return rows.map((row) => row.signature);
    },
  };
}

export default fp(
  function eventsRepositoryPlugin(fastify) {
    fastify.decorate(kEventsRepository, createRepository(fastify));
  },
  {
    name: "events-repository",
    dependencies: ["knex"],
  }
);
