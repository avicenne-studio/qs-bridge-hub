import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { PollerHandle, RECOMMENDED_POLLING_DEFAULTS } from "../infra/poller.js";
import { IdSchema, StringSchema } from "./common/schemas/common.js";
import {
  formatFirstError,
  kValidation,
} from "./common/validator.js";
import { OracleOrder, OracleOrderSchema } from "./indexer/schemas/order.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "./indexer/orders.repository.js";

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
  id: string;
  signature: string;
};

const OracleOrderWithSignatureSchema = Type.Intersect([
  Type.Object({
    id: IdSchema,
    signature: StringSchema,
  }),
  OracleOrderSchema,
]);
const OracleOrdersPayloadSchema = Type.Union([
  Type.Array(OracleOrderWithSignatureSchema),
  Type.Object({ data: Type.Array(OracleOrderWithSignatureSchema) }),
]);
type OracleOrdersPayload =
  | OracleOrderWithSignature[]
  | { data: OracleOrderWithSignature[] };

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
  payload: unknown,
  fastify: FastifyInstance,
  server: string
): OracleOrderWithSignature[] {
  const validation = fastify[kValidation];
  if (!validation.isValid<OracleOrdersPayload>(OracleOrdersPayloadSchema, payload)) {
    const reason = formatFirstError(OracleOrdersPayloadSchema, payload);
    fastify.log.warn(
      { reason, server },
      "oracle orders poll returned invalid payload"
    );
    return [];
  }

  return Array.isArray(payload) ? payload : payload.data;
}

export function groupOrdersById(
  orders: OracleOrderWithSignature[]
): OracleOrderWithSignature[][] {
  const grouped = new Map<string, OracleOrderWithSignature[]>();

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
      const headers = fastify.hubSigner.signHeaders({
        method: "GET",
        url: "/api/health",
      });

      try {
        const payload = await client.getJson<OracleHealthPayload>(
          server,
          "/api/health",
          signal,
          headers
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
  service: OracleServiceCore,
  urls: string[]
): PollerHandle {
  const client = fastify.undiciClient.create();
  const ordersRepository =
    fastify.getDecorator<OrdersRepository>(kOrdersRepository);
  const defaults = RECOMMENDED_POLLING_DEFAULTS;
  const signatureThreshold = Math.max(
    1,
    Math.floor(fastify.config.ORACLE_SIGNATURE_THRESHOLD)
  );

  const poller = fastify.poller.create<OracleOrderWithSignature[]>({
    servers: urls,
    fetchOne: async (server, signal) => {
      const entry = service.list().find((item) => item.url === server);
      if (!entry || entry.status !== "ok") {
        return [];
      }

      const headers = fastify.hubSigner.signHeaders({
        method: "GET",
        url: "/api/orders",
      });

      try {
        const payload = await client.getJson<unknown>(
          server,
          "/api/orders",
          signal,
          headers
        );
        return normalizeOrdersPayload(payload, fastify, server);
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

          const existing = await ordersRepository.findById(orderId);
          if (!existing) {
            fastify.log.warn(
              { orderId },
              "oracle orders poll skipped missing order"
            );
            continue;
          }

          const signatureCounts =
            await ordersRepository.addSignatures(orderId, signatures);
          const canBeRelayable = consensus.status !== "finalized";
          const meetsThreshold = signatureCounts.total >= signatureThreshold;
          const nextStatus =
            meetsThreshold && canBeRelayable
              ? "ready-for-relay"
              : consensus.status;

          const updated = await ordersRepository.update(orderId, {
            status: nextStatus,
          });

          if (!updated) {
            fastify.log.warn(
              { orderId },
              "oracle orders poll skipped missing order"
            );
            continue;
          }
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
    const ordersPoller = startOrdersPolling(fastify, serviceCore, urls);

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
      "hub-signer",
      "undici-client",
      "orders-repository",
      "oracle-orders-reconciliation",
      "validation",
    ],
  }
);

export { createOracleService, parseOracleUrls };
