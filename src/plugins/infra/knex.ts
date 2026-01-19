import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";
import {
  ORDERS_TABLE_NAME,
  ORDER_SIGNATURES_TABLE_NAME,
} from "../app/indexer/orders.repository.js";

export interface KnexAccessor {
  get(): Knex;
}

export const kKnex = Symbol("infra.knex");

export const autoConfig = (fastify: FastifyInstance): Knex.Config => {
  const filename = fastify.config.SQLITE_DB_FILE;

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
          table.boolean("oracle_accept_to_relay").notNullable().defaultTo(false);
          table.string("status").notNullable().defaultTo("in-progress");
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
    });
  },
  { name: "knex", dependencies: ["env"] }
);
