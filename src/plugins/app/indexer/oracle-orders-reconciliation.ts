import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import {
  OracleOrder,
  OracleOrderStatusType,
} from "./schemas/order.js";

type ReconcileFn = (orders: OracleOrder[]) => OracleOrder;

export type OracleOrdersReconciliatiorService = {
  reconcile: ReconcileFn;
};

export const kOracleOrdersReconciliatior = Symbol(
  "app.oracleOrdersReconciliatior"
);

function ensureIdenticalOrders(orders: OracleOrder[]) {
  if (orders.length === 0) {
    throw new Error("Cannot reconcile an empty orders list");
  }

  const [first, ...rest] = orders;

  for (const order of rest) {
    if (
      order.source !== first.source ||
      order.dest !== first.dest ||
      order.from !== first.from ||
      order.to !== first.to ||
      order.amount !== first.amount ||
      order.relayerFee !== first.relayerFee ||
      order.origin_trx_hash !== first.origin_trx_hash
    ) {
      throw new Error("Orders to reconcile must be identical");
    }
  }
}

function selectConsensusStatus(
  orders: OracleOrder[]
): OracleOrderStatusType {
  return selectConsensusValue(
    orders.map((order) => order.status),
    "status"
  );
}

function selectConsensusValue<T extends string>(
  values: T[],
  label: string
): T {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let winner: T | null = null;
  let highest = 0;
  let isTie = false;

  for (const [value, count] of counts) {
    if (count > highest) {
      highest = count;
      winner = value;
      isTie = false;
    } else if (count === highest) {
      isTie = true;
    }
  }

  if (winner === null || isTie) {
    throw new Error(`Unable to compute a consensus ${label}`);
  }

  return winner;
}

function selectConsensusDestinationTrxHash(
  orders: OracleOrder[]
): string | undefined {
  const hashes = orders
    .map((o) => o.destination_trx_hash)
    .filter((h): h is string => h != null && h.length > 0);

  if (hashes.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const h of hashes) {
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }

  let best: string | undefined;
  let highest = 0;
  for (const [h, count] of counts) {
    if (count > highest) {
      highest = count;
      best = h;
    }
  }

  return best;
}

export default fp(
  function (fastify: FastifyInstance) {
    const reconcile: ReconcileFn = (orders) => {
      ensureIdenticalOrders(orders);

      const consensusStatus = selectConsensusStatus(orders);
      const consensusHash = selectConsensusDestinationTrxHash(orders);
      return {
        ...orders[0],
        status: consensusStatus,
        ...(consensusHash !== undefined && { destination_trx_hash: consensusHash }),
      };
    };

    fastify.decorate(kOracleOrdersReconciliatior, {
      reconcile,
    });
  },
  {
    name: "oracle-orders-reconciliation",
  }
);
