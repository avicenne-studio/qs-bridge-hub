import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";
import { ORDERS_TABLE_NAME } from "../app/indexer/orders.repository.js";

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
      const hasTable = await fastify.knex.schema.hasTable(ORDERS_TABLE_NAME);
      if (!hasTable) {
        await fastify.knex.schema.createTable(ORDERS_TABLE_NAME, (table) => {
          table.increments("id");
          table.string("source").notNullable();
          table.string("dest").notNullable();
          table.string("from").notNullable();
          table.string("to").notNullable();
          table.float("amount").notNullable();
          table.string("status").notNullable().defaultTo("in-progress");
        });
      }
    });
  },
  { name: "knex", dependencies: ["env"] }
);
