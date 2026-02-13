import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";
import {
  ORDERS_TABLE_NAME,
  ORDER_SIGNATURES_TABLE_NAME,
} from "../app/indexer/orders.repository.js";
import { EVENTS_TABLE_NAME } from "../app/events/events.repository.js";
import { AppConfig, kConfig } from "./env.js";

export interface KnexAccessor {
  get(): Knex;
}

export const kKnex = Symbol("infra.knex");

export const autoConfig = (fastify: FastifyInstance): Knex.Config => {
  const config = fastify.getDecorator<AppConfig>(kConfig);
  const filename = config.SQLITE_DB_FILE;

  return {
    client: "better-sqlite3",
    connection: {
      filename,
    },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
  };
};

export default fp(
  async (fastify: FastifyInstance, opts: Knex.Config) => {
    const db = knex(opts);
    // Knex is callable; avoid Fastify binding functions by exposing an accessor.
    const accessor: KnexAccessor = {
      get: () => db,
    };
    fastify.decorate(kKnex, accessor);

    fastify.addHook("onClose", async () => {
      await db.destroy();
    });

    fastify.addHook("onReady", async () => {
      const hasOrdersTable = await db.schema.hasTable(ORDERS_TABLE_NAME);
      if (!hasOrdersTable) {
        await db.schema.createTable(ORDERS_TABLE_NAME, (table) => {
          table.string("id").primary().notNullable();
          table.string("source").notNullable();
          table.string("dest").notNullable();
          table.string("from").notNullable();
          table.string("to").notNullable();
          table.string("amount").notNullable();
          table.string("relayerFee").notNullable().defaultTo("0");
          table
            .string("origin_trx_hash", 255)
            .notNullable();
          table.string("source_nonce").notNullable();
          table.text("source_payload").notNullable();
          table.string("failure_reason_public").nullable();
          table.boolean("oracle_accept_to_relay").notNullable().defaultTo(false);
          table.string("status").notNullable().defaultTo("in-progress");
          table
            .timestamp("created_at", { useTz: false })
            .notNullable()
            .defaultTo(db.fn.now());
        });
      }

      const hasSignaturesTable = await db.schema.hasTable(
        ORDER_SIGNATURES_TABLE_NAME
      );
      if (!hasSignaturesTable) {
        await db.schema.createTable(
          ORDER_SIGNATURES_TABLE_NAME,
          (table) => {
            table.increments("id");
            table.string("order_id").notNullable();
            table.string("signature").notNullable();
            table.unique(["order_id", "signature"]);
          }
        );
      }

      const hasEventsTable = await db.schema.hasTable(EVENTS_TABLE_NAME);
      if (!hasEventsTable) {
        await db.schema.createTable(EVENTS_TABLE_NAME, (table) => {
          table.increments("id");
          table.string("signature").notNullable();
          table.integer("slot").nullable();
          table.string("chain").notNullable();
          table.string("type").notNullable();
          table.string("nonce").notNullable();
          table.text("payload").notNullable();
          table
            .timestamp("created_at", { useTz: false })
            .notNullable()
            .defaultTo(db.fn.now());
          table.unique(["signature", "type", "nonce"]);
        });
      }
    });
  },
  { name: "knex", dependencies: ["env"] }
);
