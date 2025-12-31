import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import {
  OracleOrder,
  OracleOrderStatusType,
} from "./schemas/order.js";

type ReconcileFn = (orders: OracleOrder[]) => OracleOrder;

declare module "fastify" {
  interface FastifyInstance {
    oracleOrdersReconciliatior: {
      reconcile: ReconcileFn;
    };
  }
}

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
      order.is_relayable !== first.is_relayable
    ) {
      throw new Error("Orders to reconcile must be identical");
    }
  }
}

function selectConsensusStatus(
  orders: OracleOrder[]
): OracleOrderStatusType {
  const counts = new Map<OracleOrderStatusType, number>();

  for (const { status } of orders) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  let winner: OracleOrderStatusType | null = null;
  let highest = 0;
  let isTie = false;

  for (const [status, count] of counts) {
    if (count > highest) {
      highest = count;
      winner = status;
      isTie = false;
    } else if (count === highest) {
      isTie = true;
    }
  }

  if (winner === null || isTie) {
    throw new Error("Unable to compute a consensus status");
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

    fastify.decorate("oracleOrdersReconciliatior", {
      reconcile,
    });
  },
  {
    name: "oracle-orders-reconciliation",
  }
);
