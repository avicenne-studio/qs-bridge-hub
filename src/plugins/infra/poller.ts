import fp from "fastify-plugin";
import { FastifyInstance, type FastifyBaseLogger } from "fastify";
import { HttpError } from "./undici-client.js";
import { AppConfig, kConfig } from "./env.js";

export type Fetcher<TResponse> = (
  server: string,
  signal: AbortSignal
) => Promise<TResponse>;

export type PollerOptions = {
  intervalMs: number;
  requestTimeoutMs: number;
  jitterMs?: number;
};

export type PollerRoundContext = {
  round: number;
  startedAt: number;
  servers: readonly string[];
  errors: readonly PollerError[];
};

export type PollerRoundHandler<TResponse> = (
  responses: TResponse[],
  context: PollerRoundContext
) => Promise<void> | void;

export type CreatePollerConfig<TResponse> = PollerOptions & {
  servers: readonly string[];
  fetchOne: Fetcher<TResponse>;
  onRound: PollerRoundHandler<TResponse>;
  logger: FastifyBaseLogger;
};

export type PollerHandle = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
};

export type PollerService = {
  defaults: Readonly<PollerOptions>;
  create<TResponse>(config: CreatePollerConfig<TResponse>): PollerHandle;
};

export const kPoller = Symbol("infra.poller");

export type PollerError = {
  server: string;
  error: unknown;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function createPoller<TResponse>(
  config: CreatePollerConfig<TResponse>
): PollerHandle {
  const {
    servers,
    fetchOne,
    onRound,
    intervalMs,
    requestTimeoutMs,
    jitterMs,
    logger,
  } = config;

  let runningPromise: Promise<void> | null = null;
  let shouldRun = false;

  async function loop() {
    let round = 0;
    while (shouldRun) {
      round += 1;
      const startedAt = Date.now();

      if (jitterMs && jitterMs > 0) {
        const delay = Math.floor(Math.random() * (jitterMs + 1));
        await sleep(delay);
      }

      const settled = await Promise.allSettled(
        servers.map((server) =>
          withTimeout(requestTimeoutMs, (signal) => fetchOne(server, signal))
        )
      );

      const success: TResponse[] = [];
      const errors: PollerError[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") {
          success.push(result.value);
          continue;
        }
        const server = servers[index];
        const error = result.reason;
        errors.push({ server, error });
        // Promise.all rethrows on first failure. Promise.allSettled lets us
        // keep the successes even when some servers fail or time out.
        const err =
          error instanceof HttpError
            ? {
                name: error.name,
                message: error.message,
                statusCode: error.statusCode,
                method: error.method,
                url: error.url,
                body: error.body,
                stack: error.stack,
              }
            : error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { value: error };
        logger.error(
          { error: err, server },
          "Poller fetchOne error"
        );
      }

      await onRound(success, {
        round,
        startedAt,
        servers: servers.slice(),
        errors,
      });

      const elapsed = Date.now() - startedAt;
      const waitFor = Math.max(0, intervalMs - elapsed);
      if (waitFor > 0) {
        await sleep(waitFor);
      }
    }
  }

  return {
    start() {
      if (runningPromise) {
        throw new Error("Poller already started");
      }
      shouldRun = true;
      runningPromise = loop().finally(() => {
        runningPromise = null;
        shouldRun = false;
      });
    },
    async stop() {
      if (!runningPromise) {
        shouldRun = false;
        return;
      }
      shouldRun = false;
      try {
        await runningPromise;
      } finally {
        runningPromise = null;
      }
    },
    isRunning() {
      return runningPromise !== null;
    },
  };
}

export default fp(
  function pollingPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kPoller)) {
      return;
    }
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const defaults: Readonly<PollerOptions> = Object.freeze({
      intervalMs: config.POLLER_INTERVAL_MS,
      requestTimeoutMs: config.POLLER_REQUEST_TIMEOUT_MS,
      jitterMs: config.POLLER_JITTER_MS,
    });
    const handles = new Set<PollerHandle>();

    fastify.decorate(kPoller, {
      defaults,
      create<TResponse>(config: CreatePollerConfig<TResponse>) {
        const handle = createPoller({ ...config, logger: fastify.log });
        handles.add(handle);
        return handle;
      },
    });

    fastify.addHook("onClose", async () => {
      await Promise.all(
        [...handles].map(async (handle) => {
          await handle.stop();
        })
      );
      handles.clear();
    });
  },
  {
    name: "polling",
  }
);
