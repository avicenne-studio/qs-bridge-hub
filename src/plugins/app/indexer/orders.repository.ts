import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

import { OracleOrder } from "./schemas/order.js";

export const ORDERS_TABLE_NAME = "orders";
export const ORDER_SIGNATURES_TABLE_NAME = "order_signatures";

declare module "fastify" {
  interface FastifyInstance {
    ordersRepository: ReturnType<typeof createRepository>;
  }
}

type PersistedOrder = OracleOrder & { id: number };
type StoredOrder = PersistedOrder;
type CreateOrder = PersistedOrder;
type UpdateOrder = Partial<OracleOrder>;
type PersistedSignature = {
  order_id: number;
  signature: string;
};
type StoredSignature = PersistedSignature & { id: number };
type OrderWithSignatures = StoredOrder & { signatures: StoredSignature[] };

type OrderQuery = {
  page: number;
  limit: number;
  order: "asc" | "desc";
  source?: OracleOrder["source"];
  dest?: OracleOrder["dest"];
};

type OrderWithTotal = StoredOrder & { total: number };

function normalizeStoredOrder(row: StoredOrder): StoredOrder {
  return {
    ...row,
    is_relayable: Boolean(row.is_relayable),
  };
}

function createRepository(fastify: FastifyInstance) {
  const knex = fastify.knex;

  return {
    async paginate(q: OrderQuery) {
      const offset = (q.page - 1) * q.limit;

      const query = knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("id", "source", "dest", "from", "to", "amount", "is_relayable", "status")
        .select(knex.raw("count(*) OVER() as total"));

      if (q.source !== undefined) {
        query.where({ source: q.source });
      }

      if (q.dest !== undefined) {
        query.where({ dest: q.dest });
      }

      const rows = (await query
        .limit(q.limit)
        .offset(offset)
        .orderBy("id", q.order)) as unknown as OrderWithTotal[];

      const orders = rows.map((row) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { total: _total, ...orderRow } = row;
        return normalizeStoredOrder(orderRow);
      });

      return {
        orders,
        total: rows.length > 0 ? Number(rows[0].total) : 0,
      };
    },

    async findById(id: number) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("id", "source", "dest", "from", "to", "amount", "is_relayable", "status")
        .where("id", id)
        .first();
      return row ? normalizeStoredOrder(row as StoredOrder) : null;
    },

    async create(newOrder: CreateOrder) {
      await knex<PersistedOrder>(ORDERS_TABLE_NAME).insert(newOrder);
      return this.findById(newOrder.id);
    },

    async update(id: number, changes: UpdateOrder) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .update(changes);

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async delete(id: number) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .delete();

      return affectedRows > 0;
    },

    async findActivesIds(limit = 100) {
      const rows = await knex<{ id: number }>(ORDERS_TABLE_NAME)
        .select("id")
        .whereIn("status", ["pending", "in-progress"])
        .orderBy("id", "asc")
        .limit(limit);

      return rows.map((row) => Number(row.id));
    },

    async addSignatures(orderId: number, signatures: string[]) {
      const unique = [...new Set(signatures)];
      if (unique.length === 0) {
        return [];
      }

      const existing = await knex<PersistedSignature>(ORDER_SIGNATURES_TABLE_NAME)
        .select("signature")
        .where({ order_id: orderId })
        .whereIn("signature", unique);

      const existingSet = new Set(existing.map((row) => row.signature));
      const toInsert = unique.filter((signature) => !existingSet.has(signature));

      if (toInsert.length === 0) {
        return [];
      }

      await knex<PersistedSignature>(ORDER_SIGNATURES_TABLE_NAME).insert(
        toInsert.map((signature) => ({
          order_id: orderId,
          signature,
        }))
      );

      return toInsert;
    },

    async findByIdsWithSignatures(ids: number[]): Promise<OrderWithSignatures[]> {
      if (ids.length === 0) {
        return [];
      }

      const orders = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("id", "source", "dest", "from", "to", "amount", "is_relayable", "status")
        .whereIn("id", ids)
        .orderBy("id", "asc");

      if (orders.length === 0) {
        return [];
      }

      const orderIds = orders.map((order) => Number((order as StoredOrder).id));
      const signatures = await knex<StoredSignature>(ORDER_SIGNATURES_TABLE_NAME)
        .select("id", "order_id", "signature")
        .whereIn("order_id", orderIds);

      const grouped = new Map<number, StoredSignature[]>();
      for (const signature of signatures) {
        const list = grouped.get(signature.order_id) ?? [];
        list.push(signature);
        grouped.set(signature.order_id, list);
      }

      return orders.map((order) => {
        const stored = normalizeStoredOrder(order as StoredOrder);
        return {
          ...stored,
          signatures: grouped.get(stored.id) ?? [],
        };
      });
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
