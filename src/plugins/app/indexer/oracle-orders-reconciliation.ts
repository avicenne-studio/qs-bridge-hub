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

type ConsensusCounts = {
  status: Map<OracleOrderStatusType, number>;
  relayerFee: Map<string, number>;
  to: Map<string, number>;
  destinationTrxHash: Map<string, number>;
  failureReason: Map<string, number>;
};

function createCounts(): ConsensusCounts {
  return {
    status: new Map(),
    relayerFee: new Map(),
    to: new Map(),
    destinationTrxHash: new Map(),
    failureReason: new Map(),
  };
}

function tally<T extends string>(counts: Map<T, number>, value: T) {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function selectConsensusFromCounts<T extends string>(
  counts: Map<T, number>,
  label: string
): T {
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

function selectBestOptional(counts: Map<string, number>): string | undefined {
  if (counts.size === 0) {
    return undefined;
  }
  let best: string | undefined;
  let highest = 0;
  for (const [value, count] of counts) {
    if (count > highest) {
      highest = count;
      best = value;
    }
  }
  return best;
}

function computeConsensus(orders: OracleOrder[]) {
  if (orders.length === 0) {
    throw new Error("Cannot reconcile an empty orders list");
  }

  const [first] = orders;
  const counts = createCounts();

  for (const order of orders) {
    if (
      order.source !== first.source ||
      order.dest !== first.dest ||
      order.from !== first.from ||
      order.amount !== first.amount ||
      order.origin_trx_hash !== first.origin_trx_hash
    ) {
      throw new Error("Orders to reconcile must be identical");
    }

    tally(counts.status, order.status);
    tally(counts.relayerFee, order.relayerFee);
    tally(counts.to, order.to);

    if (order.destination_trx_hash && order.destination_trx_hash.length > 0) {
      tally(counts.destinationTrxHash, order.destination_trx_hash);
    }

    if (order.failure_reason_public && order.failure_reason_public.length > 0) {
      tally(counts.failureReason, order.failure_reason_public);
    }
  }

  const status = selectConsensusFromCounts(counts.status, "status");
  const relayerFee = selectConsensusFromCounts(counts.relayerFee, "relayerFee");
  const to = selectConsensusFromCounts(counts.to, "to");
  const destinationTrxHash = selectBestOptional(counts.destinationTrxHash);
  const failureReason =
    status === "failed" ? selectBestOptional(counts.failureReason) : undefined;

  return {
    status,
    relayerFee,
    to,
    destinationTrxHash,
    failureReason,
  };
}

export default fp(
  function (fastify: FastifyInstance) {
    const reconcile: ReconcileFn = (orders) => {
      const {
        status: consensusStatus,
        relayerFee: consensusRelayerFee,
        to: consensusTo,
        destinationTrxHash: consensusHash,
        failureReason: consensusFailureReason,
      } = computeConsensus(orders);
      const reconciled: OracleOrder = {
        ...orders[0],
        status: consensusStatus,
        to: consensusTo,
        relayerFee: consensusRelayerFee,
        ...(consensusHash !== undefined && { destination_trx_hash: consensusHash }),
      };
      if (consensusStatus === "failed" && consensusFailureReason !== undefined) {
          reconciled.failure_reason_public = consensusFailureReason;
      } else {
        delete reconciled.failure_reason_public;
      }

      return reconciled;
    };

    fastify.decorate(kOracleOrdersReconciliatior, {
      reconcile,
    });
  },
  {
    name: "oracle-orders-reconciliation",
  }
);
