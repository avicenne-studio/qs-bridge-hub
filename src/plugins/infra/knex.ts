import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";
import {
  ORDERS_TABLE_NAME,
  ORDER_SIGNATURES_TABLE_NAME,
} from "../app/indexer/orders.repository.js";

declare module "fastify" {
  export interface FastifyInstance {
    knex: Knex;
  }
}

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
    fastify.decorate("knex", db);

    fastify.addHook("onClose", async (instance) => {
      await instance.knex.destroy();
    });

    fastify.addHook("onReady", async () => {
      const hasOrdersTable = await fastify.knex.schema.hasTable(ORDERS_TABLE_NAME);
      if (!hasOrdersTable) {
        await fastify.knex.schema.createTable(ORDERS_TABLE_NAME, (table) => {
          table.integer("id").primary().notNullable();
          table.string("source").notNullable();
          table.string("dest").notNullable();
          table.string("from").notNullable();
          table.string("to").notNullable();
          table.float("amount").notNullable();
          table.boolean("oracle_accept_to_relay").notNullable().defaultTo(false);
          table.string("status").notNullable().defaultTo("in-progress");
        });
      }

      const hasSignaturesTable = await fastify.knex.schema.hasTable(
        ORDER_SIGNATURES_TABLE_NAME
      );
      if (!hasSignaturesTable) {
        await fastify.knex.schema.createTable(
          ORDER_SIGNATURES_TABLE_NAME,
          (table) => {
            table.increments("id");
            table.integer("order_id").notNullable();
            table.string("signature").notNullable();
            table.unique(["order_id", "signature"]);
          }
        );
      }
    });
  },
  { name: "knex", dependencies: ["env"] }
);
