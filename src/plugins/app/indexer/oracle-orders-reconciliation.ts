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
      order.amount !== first.amount ||
      order.source_nonce !== first.source_nonce ||
      order.source_payload !== first.source_payload ||
      order.oracle_accept_to_relay !== first.oracle_accept_to_relay
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

function selectConsensusValue(values: string[], label: string): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let winner: string | null = null;
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
      const consensusTo = selectConsensusValue(
        orders.map((order) => order.to),
        "destination"
      );
      const consensusRelayerFee = selectConsensusValue(
        orders.map((order) => order.relayerFee),
        "relayer fee"
      );

      return {
        ...orders[0],
        to: consensusTo,
        relayerFee: consensusRelayerFee,
        status: consensusStatus,
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
