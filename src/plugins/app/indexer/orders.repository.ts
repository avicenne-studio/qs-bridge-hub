import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

import { OracleOrder } from "./schemas/order.js";

export const ORDERS_TABLE_NAME = "orders";

declare module "fastify" {
  interface FastifyInstance {
    ordersRepository: ReturnType<typeof createRepository>;
  }
}

type PersistedOrder = OracleOrder;
type StoredOrder = OracleOrder & { id: number };
type CreateOrder = OracleOrder;
type UpdateOrder = Partial<OracleOrder>;

type OrderQuery = {
  page: number;
  limit: number;
  order: "asc" | "desc";
  source?: OracleOrder["source"];
  dest?: OracleOrder["dest"];
};

type OrderWithTotal = StoredOrder & { total: number };

function createRepository(fastify: FastifyInstance) {
  const knex = fastify.knex;

  return {
    async paginate(q: OrderQuery) {
      const offset = (q.page - 1) * q.limit;

      const query = knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select(knex.raw("rowid as id"), "*")
        .select(knex.raw("count(*) OVER() as total"));

      if (q.source !== undefined) {
        query.where({ source: q.source });
      }

      if (q.dest !== undefined) {
        query.where({ dest: q.dest });
      }

      const rows = await query
        .limit(q.limit)
        .offset(offset)
        .orderBy("rowid", q.order);

      const orders = rows.map((row) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { total: _total, ...orderRow } = row as OrderWithTotal;
        return orderRow as StoredOrder;
      });

      return {
        orders,
        total: rows.length > 0 ? Number((rows[0] as OrderWithTotal).total) : 0,
      };
    },

    async findById(id: number) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select(knex.raw("rowid as id"), "*")
        .where("rowid", id)
        .first();
      return row ?? null;
    },

    async create(newOrder: CreateOrder) {
      const [id] = await knex<PersistedOrder>(ORDERS_TABLE_NAME).insert(newOrder);
      return this.findById(Number(id));
    },

    async update(id: number, changes: UpdateOrder) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("rowid", id)
        .update(changes);

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async delete(id: number) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("rowid", id)
        .delete();

      return affectedRows > 0;
    },
  };
}

export default fp(
  function (fastify) {
    fastify.decorate("ordersRepository", createRepository(fastify));
  },
  {
    name: "orders-repository",
    dependencies: ["knex"],
  }
);
