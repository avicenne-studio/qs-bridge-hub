import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { PollerHandle, RECOMMENDED_POLLING_DEFAULTS } from "../infra/poller.js";
import { OracleOrder } from "./indexer/schemas/order.js";

type OracleStatus = "ok" | "down";

export type OracleHealthRecord = {
  status: OracleStatus;
  timestamp: string;
};

export type OracleHealthEntry = {
  url: string;
} & OracleHealthRecord;

type OracleServiceCore = {
  list(): OracleHealthEntry[];
  update(url: string, health: OracleHealthRecord): void;
};
export type OracleService = OracleServiceCore & {
  pollOrders(): PollerHandle;
};

type OracleHealthPayload = {
  status: OracleStatus;
  timestamp?: string;
};

type PolledOracleHealth = {
  url: string;
  health: OracleHealthRecord;
};

export type OracleOrderWithSignature = OracleOrder & {
  id: number;
  signature: string;
};

type OracleOrdersResponse =
  | { data: OracleOrderWithSignature[] }
  | OracleOrderWithSignature[];

function normalizeHealth(payload: OracleHealthPayload): OracleHealthRecord {
  const status: OracleStatus = payload.status === "ok" ? "ok" : "down";
  return {
    status,
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };
}

function createOracleService(urls: string[]): OracleServiceCore {
  const registry = new Map<string, OracleHealthRecord>();
  const initialTimestamp = new Date().toISOString();

  urls.forEach((url) => {
    registry.set(url, {
      status: "down",
      timestamp: initialTimestamp,
    });
  });

  return {
    list() {
      return [...registry.entries()].map(([url, health]) => ({
        url,
        ...health,
      }));
    },
    update(url, next) {
      registry.set(url, next);
    },
  };
}

declare module "fastify" {
  interface FastifyInstance {
    oracleService: OracleService;
  }
}

function parseOracleUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeOrdersPayload(
  payload: OracleOrdersResponse
): OracleOrderWithSignature[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.data ?? [];
}

export function groupOrdersById(
  orders: OracleOrderWithSignature[]
): OracleOrderWithSignature[][] {
  const grouped = new Map<number, OracleOrderWithSignature[]>();

  for (const order of orders) {
    const list = grouped.get(order.id) ?? [];
    list.push(order);
    grouped.set(order.id, list);
  }

  return [...grouped.values()];
}

function startHealthPolling(
  fastify: FastifyInstance,
  service: OracleService,
  urls: string[]
) {
  const client = fastify.undiciClient.create();
  const defaults = RECOMMENDED_POLLING_DEFAULTS;

  const poller = fastify.poller.create({
    servers: urls,
    fetchOne: async (server, signal) => {
      try {
        const payload = await client.getJson<OracleHealthPayload>(
          server,
          "/api/health",
          signal
        );
        return {
          url: server,
          health: normalizeHealth(payload),
        } satisfies PolledOracleHealth;
      } catch (err) {
        fastify.log.warn(
          { err, server },
          "oracle health poll failed; marking oracle as down"
        );
        return {
          url: server,
          health: normalizeHealth({
            status: "down",
          }),
        } satisfies PolledOracleHealth;
      }
    },
    onRound: (responses) => {
      for (const result of responses) {
        service.update(result.url, result.health);
      }
    },
    intervalMs: defaults.intervalMs,
    requestTimeoutMs: defaults.requestTimeoutMs,
    jitterMs: defaults.jitterMs,
  });

  poller.start();
}

function startOrdersPolling(
  fastify: FastifyInstance,
  urls: string[]
): PollerHandle {
  const client = fastify.undiciClient.create();
  const defaults = RECOMMENDED_POLLING_DEFAULTS;

  const poller = fastify.poller.create<OracleOrderWithSignature[]>({
    servers: urls,
    fetchOne: async (server, signal) => {
      const ids = await fastify.ordersRepository.findActivesIds();
      if (ids.length === 0) {
        return [];
      }

      try {
        const payload = await client.postJson<OracleOrdersResponse>(
          server,
          "/api/orders",
          { ids },
          signal
        );
        return normalizeOrdersPayload(payload);
      } catch (err) {
        fastify.log.warn(
          { err, server },
          "oracle orders poll failed"
        );
        return [];
      }
    },
    onRound: async (responses) => {
      const orders = responses.flat();
      if (orders.length === 0) {
        return;
      }

      const grouped = groupOrdersById(orders);
      for (const group of grouped) {
        const orderId = group[0].id;
        const signatures = group.map((entry) => entry.signature);
        const reconciledOrders = group.map(
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ({ signature: _signature, id: _id, ...order }) => order
        );

        try {
          const consensus =
            fastify.oracleOrdersReconciliatior.reconcile(reconciledOrders);

          const updated = await fastify.ordersRepository.update(orderId, {
            status: consensus.status,
            is_relayable: consensus.is_relayable,
          });

          if (!updated) {
            fastify.log.warn(
              { orderId },
              "oracle orders poll skipped missing order"
            );
            continue;
          }

          await fastify.ordersRepository.addSignatures(orderId, signatures);
        } catch (err) {
          fastify.log.warn(
            { err, orderId },
            "oracle orders reconciliation failed"
          );
        }
      }
    },
    intervalMs: defaults.intervalMs,
    requestTimeoutMs: defaults.requestTimeoutMs,
    jitterMs: defaults.jitterMs,
  });

  poller.start();
  return poller;
}

export default fp(
  async function oracleServicePlugin(fastify: FastifyInstance) {
    const urls = parseOracleUrls(fastify.config.ORACLE_URLS);
    const serviceCore = createOracleService(urls);
    const ordersPoller = startOrdersPolling(fastify, urls);

    const pollOrders = () => ordersPoller;

    const service: OracleService = {
      ...serviceCore,
      pollOrders,
    };

    fastify.decorate("oracleService", service);
    startHealthPolling(fastify, service, urls);
  },
  {
    name: "oracle-service",
    dependencies: [
      "env",
      "polling",
      "undici-client",
      "orders-repository",
      "oracle-orders-reconciliation",
    ],
  }
);

export { createOracleService, parseOracleUrls };
