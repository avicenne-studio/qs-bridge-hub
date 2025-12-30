import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { RECOMMENDED_POLLING_DEFAULTS } from "../infra/poller.js";

type OracleStatus = "ok" | "down";

export type OracleHealthRecord = {
  status: OracleStatus;
  timestamp: string;
};

export type OracleHealthEntry = {
  url: string;
} & OracleHealthRecord;

export type OracleService = {
  list(): OracleHealthEntry[];
  update(url: string, health: OracleHealthRecord): void;
};

type OracleHealthPayload = {
  status: OracleStatus;
  timestamp?: string;
};

type PolledOracleHealth = {
  url: string;
  health: OracleHealthRecord;
};

function normalizeHealth(payload: OracleHealthPayload): OracleHealthRecord {
  const status: OracleStatus = payload.status === "ok" ? "ok" : "down";
  return {
    status,
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };
}

function createOracleService(urls: string[]): OracleService {
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

function startHealthPolling(
  fastify: FastifyInstance,
  service: OracleService,
  urls: string[]
) {
  const client = fastify.undiciGetClient.create();
  const defaults = RECOMMENDED_POLLING_DEFAULTS

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

export default fp(
  async function oracleServicePlugin(fastify: FastifyInstance) {
    const urls = parseOracleUrls(fastify.config.ORACLE_URLS);
    const service = createOracleService(urls);
    fastify.decorate("oracleService", service);
    startHealthPolling(fastify, service, urls);
  },
  {
    name: "oracle-service",
    dependencies: ["env", "polling", "undici-get-client"],
  }
);

export { createOracleService, parseOracleUrls };
