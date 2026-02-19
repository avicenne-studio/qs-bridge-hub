import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { PollerHandle, PollerService, kPoller } from "../infra/poller.js";
import { IdSchema, StringSchema } from "./common/schemas/common.js";
import {
  formatFirstError,
  kValidation,
  ValidationService,
} from "./common/validator.js";
import { OracleOrder, OracleOrderSchema } from "./indexer/schemas/order.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "./indexer/orders.repository.js";
import {
  OracleOrdersReconciliatiorService,
  kOracleOrdersReconciliatior,
} from "./indexer/oracle-orders-reconciliation.js";
import { UndiciClientService, kUndiciClient } from "../infra/undici-client.js";
import { HubSignerService, kHubSigner } from "../infra/hub-signer.js";
import { AppConfig, kConfig } from "../infra/env.js";

type OracleStatus = "ok" | "down";

export type OracleHealthRecord = {
  status: OracleStatus;
  timestamp: string;
  relayerFeeSolana: bigint;
  relayerFeeQubic: bigint;
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
  relayerFeeSolana?: string;
  relayerFeeQubic?: string;
};

type PolledOracleHealth = {
  url: string;
  health: OracleHealthRecord;
};

export type OracleOrderWithSignature = OracleOrder & {
  id: string;
  signature: string;
};

const HUB_ORDER_FIELDS = [
  "source",
  "dest",
  "from",
  "to",
  "amount",
  "relayerFee",
  "origin_trx_hash",
  "destination_trx_hash",
  "source_nonce",
  "source_payload",
  "failure_reason_public",
  "status",
] as const;

function pickHubOrderFields(order: OracleOrder): OracleOrder {
  const picked: Record<string, unknown> = {};
  for (const key of HUB_ORDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(order, key)) {
      picked[key] = order[key];
    }
  }
  return picked as OracleOrder;
}

export const kOracleService = Symbol("app.oracleService");

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

function parseRelayerFee(value?: string): bigint {
  if (!value || !/^[0-9]+$/.test(value)) {
    return 0n;
  }
  return BigInt(value);
}

function normalizeHealth(payload: OracleHealthPayload): OracleHealthRecord {
  const status: OracleStatus = payload.status === "ok" ? "ok" : "down";
  return {
    status,
    timestamp: payload.timestamp ?? new Date().toISOString(),
    relayerFeeSolana: parseRelayerFee(payload.relayerFeeSolana),
    relayerFeeQubic: parseRelayerFee(payload.relayerFeeQubic),
  };
}

function createOracleService(urls: string[]): OracleServiceCore {
  const registry = new Map<string, OracleHealthRecord>();
  const initialTimestamp = new Date().toISOString();

  urls.forEach((url) => {
    registry.set(url, {
      status: "down",
      timestamp: initialTimestamp,
      relayerFeeSolana: 0n,
      relayerFeeQubic: 0n,
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

function parseOracleUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeOrdersPayload(
  payload: unknown,
  validation: ValidationService,
  fastify: FastifyInstance,
  server: string,
): OracleOrderWithSignature[] {
  if (
    validation.isValid<OracleOrdersPayload>(OracleOrdersPayloadSchema, payload)
  ) {
    return Array.isArray(payload) ? payload : payload.data;
  }

  const payloadType = Array.isArray(payload) ? "array" : typeof payload;
  const payloadKeys =
    payload && typeof payload === "object"
      ? Object.keys(payload as Record<string, unknown>).slice(0, 8)
      : [];
  const reason = formatFirstError(OracleOrdersPayloadSchema, payload);
  fastify.log.warn(
    { reason, server, payloadType, payloadKeys },
    "oracle orders poll returned invalid payload",
  );
  return [];
}

export function groupOrdersById(
  orders: OracleOrderWithSignature[],
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
  urls: string[],
  deps: {
    undiciClient: UndiciClientService;
    hubSigner: HubSignerService;
    pollerService: PollerService;
  },
) {
  const { undiciClient, hubSigner, pollerService } = deps;
  const client = undiciClient.create();
  const defaults = pollerService.defaults;

  const poller = pollerService.create({
    servers: urls,
    fetchOne: async (server, signal) => {
      const headers = hubSigner.signHeaders({
        method: "GET",
        url: "/api/health",
      });

      try {
        const payload = await client.getJson<OracleHealthPayload>(
          server,
          "/api/health",
          signal,
          headers,
        );
        return {
          url: server,
          health: normalizeHealth(payload),
        } satisfies PolledOracleHealth;
      } catch (err) {
        fastify.log.warn(
          { err, server },
          "oracle health poll failed; marking oracle as down",
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
  urls: string[],
  deps: {
    undiciClient: UndiciClientService;
    hubSigner: HubSignerService;
    pollerService: PollerService;
    ordersRepository: OrdersRepository;
    reconciliator: OracleOrdersReconciliatiorService;
    validation: ValidationService;
    config: AppConfig;
  },
): PollerHandle {
  const {
    undiciClient,
    hubSigner,
    pollerService,
    ordersRepository,
    reconciliator,
    validation,
    config,
  } = deps;
  const client = undiciClient.create();
  const defaults = pollerService.defaults;
  const requiredSignatures = () =>
    computeRequiredSignatures(
      config.ORACLE_SIGNATURE_THRESHOLD,
      config.ORACLE_COUNT,
    );

  const poller = pollerService.create<OracleOrderWithSignature[]>({
    servers: urls,
    fetchOne: async (server, signal) => {
      const entry = service.list().find((item) => item.url === server);
      if (!entry || entry.status !== "ok") {
        return [];
      }

      const headers = hubSigner.signHeaders({
        method: "GET",
        url: "/api/orders",
      });

      try {
        const payload = await client.getJson<unknown>(
          server,
          "/api/orders",
          signal,
          headers,
        );
        
        return normalizeOrdersPayload(payload, validation, fastify, server);
      } catch (err) {
        fastify.log.warn({ err, server }, "oracle orders poll failed");
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
          ({ signature: _signature, id: _id, ...order }) =>
            pickHubOrderFields(order),
        );

        try {
          const consensus = reconciliator.reconcile(reconciledOrders);

          let existing = await ordersRepository.findById(orderId);
          if (!existing) {
            existing = await ordersRepository.create({
              id: orderId,
              ...pickHubOrderFields(consensus),
            });
            if (!existing) {
              fastify.log.warn(
                { orderId },
                "oracle orders poll skipped missing order",
              );
              continue;
            }
          }

          const signatureCounts = await ordersRepository.addSignatures(
            orderId,
            signatures,
          );
          const canBeRelayable =
            consensus.status !== "finalized" && consensus.status !== "relayed";
          const meetsThreshold = signatureCounts.total >= requiredSignatures();
          const nextStatus =
            meetsThreshold && canBeRelayable
              ? "ready-for-relay"
              : consensus.status;

          const updated = await ordersRepository.update(orderId, {
            status: nextStatus,
            ...(consensus.destination_trx_hash && {
              destination_trx_hash: consensus.destination_trx_hash,
            }),
          });

          if (!updated) {
            fastify.log.warn(
              { orderId },
              "oracle orders poll skipped missing order",
            );
            continue;
          }
        } catch (err) {
          fastify.log.warn(
            { err, orderId },
            "oracle orders reconciliation failed",
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
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const validation = fastify.getDecorator<ValidationService>(kValidation);
    const undiciClient =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);
    const hubSigner = fastify.getDecorator<HubSignerService>(kHubSigner);
    const pollerService = fastify.getDecorator<PollerService>(kPoller);
    const ordersRepository =
      fastify.getDecorator<OrdersRepository>(kOrdersRepository);
    const reconciliator =
      fastify.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior,
      );
    const urls = parseOracleUrls(config.ORACLE_URLS);
    const serviceCore = createOracleService(urls);
    const ordersPoller = startOrdersPolling(fastify, serviceCore, urls, {
      undiciClient,
      hubSigner,
      pollerService,
      ordersRepository,
      reconciliator,
      validation,
      config,
    });

    const pollOrders = () => ordersPoller;

    const service: OracleService = {
      ...serviceCore,
      pollOrders,
    };

    fastify.decorate(kOracleService, service);
    startHealthPolling(fastify, service, urls, {
      undiciClient,
      hubSigner,
      pollerService,
    });
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
  },
);

export function computeRequiredSignatures(
  signatureThreshold: number,
  oracleCount: number,
) {
  const threshold = Math.max(0, signatureThreshold);
  const total = Math.max(1, Math.floor(oracleCount));
  if (threshold > 0 && threshold <= 1) {
    return Math.max(1, Math.ceil(total * threshold));
  }
  return Math.max(1, Math.floor(threshold));
}

export { createOracleService, parseOracleUrls };
