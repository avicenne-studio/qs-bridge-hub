import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kKnex, type KnexAccessor } from "../../infra/knex.js";

import { OracleOrder } from "./schemas/order.js";

export const ORDERS_TABLE_NAME = "orders";
export const ORDER_SIGNATURES_TABLE_NAME = "order_signatures";

export interface OrdersRepository {
  paginate(q: OrderQuery): Promise<{ orders: StoredOrder[]; total: number }>;
  findById(id: string): Promise<StoredOrder | null>;
  findByOriginTrxHash(hash: string): Promise<StoredOrder | null>;
  create(newOrder: StoredOrder): Promise<StoredOrder | null>;
  update(id: string, changes: Partial<OracleOrder>): Promise<StoredOrder | null>;
  delete(id: string): Promise<boolean>;
  findActivesIds(limit?: number): Promise<string[]>;
  findRelayableIds(limit?: number): Promise<string[]>;
  addSignatures(
    orderId: string,
    signatures: string[]
  ): Promise<{ added: number; total: number }>;
  findByIdsWithSignatures(ids: string[]): Promise<OrderWithSignatures[]>;
}

export const kOrdersRepository = Symbol("app.ordersRepository");

type PersistedOrder = OracleOrder & { id: string };
export type StoredOrder = OracleOrder & { id: string };
type CreateOrder = StoredOrder;
type UpdateOrder = Partial<OracleOrder>;
type PersistedSignature = {
  order_id: string;
  signature: string;
};
export type StoredSignature = PersistedSignature & { id: number };
export type OrderWithSignatures = StoredOrder & { signatures: StoredSignature[] };

export type OrderQuery = {
  page: number;
  limit: number;
  order: "asc" | "desc";
  source?: OracleOrder["source"];
  dest?: OracleOrder["dest"];
  status?: OracleOrder["status"][];
  from?: string;
  to?: string;
  amount_min?: string;
  amount_max?: string;
  created_after?: string;
  created_before?: string;
  id?: string;
};

type OrderWithTotal = StoredOrder & { total: number };

function normalizeStoredOrder(row: StoredOrder): StoredOrder {
  return {
    ...row,
    oracle_accept_to_relay: Boolean(row.oracle_accept_to_relay),
    failure_reason_public: row.failure_reason_public ?? undefined,
  };
}

function createRepository(fastify: FastifyInstance): OrdersRepository {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async paginate(q: OrderQuery) {
      const offset = (q.page - 1) * q.limit;

      const query = knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select(
          "id",
          "source",
          "dest",
          "from",
          "to",
          "amount",
          "relayerFee",
          "origin_trx_hash",
          "source_nonce",
          "source_payload",
          "failure_reason_public",
          "oracle_accept_to_relay",
          "status"
        )
        .select(knex.raw("count(*) OVER() as total"));

      if (q.source !== undefined) {
        query.where({ source: q.source });
      }

      if (q.dest !== undefined) {
        query.where({ dest: q.dest });
      }

      if (q.status !== undefined && q.status.length > 0) {
        query.whereIn("status", q.status);
      }

      if (q.from !== undefined) {
        query.where({ from: q.from });
      }

      if (q.to !== undefined) {
        query.where({ to: q.to });
      }

      if (q.amount_min !== undefined) {
        query.whereRaw("CAST(amount AS INTEGER) >= ?", [q.amount_min]);
      }

      if (q.amount_max !== undefined) {
        query.whereRaw("CAST(amount AS INTEGER) <= ?", [q.amount_max]);
      }

      if (q.created_after !== undefined) {
        query.where("created_at", ">=", q.created_after);
      }

      if (q.created_before !== undefined) {
        query.where("created_at", "<=", q.created_before);
      }

      if (q.id !== undefined) {
        query.where({ id: q.id });
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

    async findById(id: string) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select(
          "id",
          "source",
          "dest",
          "from",
          "to",
          "amount",
          "relayerFee",
          "origin_trx_hash",
          "source_nonce",
          "source_payload",
          "failure_reason_public",
          "oracle_accept_to_relay",
          "status"
        )
        .where("id", id)
        .first();
      return row ? normalizeStoredOrder(row as StoredOrder) : null;
    },

    async findByOriginTrxHash(hash: string) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select(
          "id",
          "source",
          "dest",
          "from",
          "to",
          "amount",
          "relayerFee",
          "origin_trx_hash",
          "source_nonce",
          "source_payload",
          "failure_reason_public",
          "oracle_accept_to_relay",
          "status"
        )
        .where("origin_trx_hash", hash)
        .first();
      return row ? normalizeStoredOrder(row as StoredOrder) : null;
    },

    async create(newOrder: CreateOrder) {
      const sourceNonce =
        newOrder.source_nonce ?? `${newOrder.origin_trx_hash}-${newOrder.id}`;
      const sourcePayload =
        newOrder.source_payload ??
        JSON.stringify({ origin_trx_hash: newOrder.origin_trx_hash });
      await knex<PersistedOrder>(ORDERS_TABLE_NAME).insert({
        ...newOrder,
        source_nonce: sourceNonce,
        source_payload: sourcePayload,
      });
      return this.findById(newOrder.id);
    },

    async update(id: string, changes: UpdateOrder) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .update(changes);

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async delete(id: string) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .delete();

      return affectedRows > 0;
    },

    async findActivesIds(limit = 100) {
      const rows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("id")
        .whereIn("status", ["pending", "in-progress"])
        .orderBy("id", "asc")
        .limit(limit);

      return rows.map((row) => String(row.id));
    },

    async findRelayableIds(limit = 100) {
      const rows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("id")
        .where({ status: "ready-for-relay" })
        .orderBy("id", "asc")
        .limit(limit);

      return rows.map((row) => String(row.id));
    },

    async addSignatures(orderId: string, signatures: string[]) {
      const unique = [...new Set(signatures)];
      const existing = await knex<PersistedSignature>(ORDER_SIGNATURES_TABLE_NAME)
        .select("signature")
        .where({ order_id: orderId });
      const existingSet = new Set(existing.map((row) => row.signature));
      const toInsert = unique.filter((signature) => !existingSet.has(signature));

      if (toInsert.length > 0) {
        await knex<PersistedSignature>(ORDER_SIGNATURES_TABLE_NAME)
          .insert(
            toInsert.map((signature) => ({
              order_id: orderId,
              signature,
            }))
          )
          .onConflict(["order_id", "signature"])
          .ignore();
      }

      return {
        added: toInsert.length,
        total: existingSet.size + toInsert.length,
      };
    },

    async findByIdsWithSignatures(ids: string[]): Promise<OrderWithSignatures[]> {
      if (ids.length === 0) {
        return [];
      }

      const orders = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select(
          "id",
          "source",
          "dest",
          "from",
          "to",
          "amount",
          "relayerFee",
          "origin_trx_hash",
          "source_nonce",
          "source_payload",
          "oracle_accept_to_relay",
          "status"
        )
        .whereIn("id", ids)
        .orderBy("id", "asc");

      if (orders.length === 0) {
        return [];
      }

      const orderIds = orders.map((order) => String((order as StoredOrder).id));
      const signatures = await knex<StoredSignature>(ORDER_SIGNATURES_TABLE_NAME)
        .select("id", "order_id", "signature")
        .whereIn("order_id", orderIds);

      const grouped = new Map<string, StoredSignature[]>();
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
    fastify.decorate(kOrdersRepository, createRepository(fastify));
  },
  {
    name: "orders-repository",
    dependencies: ["knex"],
  }
);
