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
      order.origin_trx_hash !== first.origin_trx_hash ||
      order.oracle_accept_to_relay !== first.oracle_accept_to_relay
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

export default fp(
  function (fastify: FastifyInstance) {
    const reconcile: ReconcileFn = (orders) => {
      ensureIdenticalOrders(orders);

      const consensusStatus = selectConsensusStatus(orders);
      return { ...orders[0], status: consensusStatus };
    };

    fastify.decorate(kOracleOrdersReconciliatior, {
      reconcile,
    });
  },
  {
    name: "oracle-orders-reconciliation",
  }
);
