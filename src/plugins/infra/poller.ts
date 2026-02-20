import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { AppConfig, kConfig } from "./env.js";

export type Fetcher<TResponse> = (
  server: string,
  signal: AbortSignal
) => Promise<TResponse>;

export type PollerOptions = {
  intervalMs: number | (() => number);
  requestTimeoutMs: number;
  jitterMs?: number;
};

export type PollerRoundContext = {
  round: number;
  startedAt: number;
  servers: readonly string[];
};

export type PollerRoundHandler<TResponse> = (
  responses: TResponse[],
  context: PollerRoundContext
) => Promise<void> | void;

export type CreatePollerConfig<TResponse> = PollerOptions & {
  servers: readonly string[];
  fetchOne: Fetcher<TResponse>;
  onRound: PollerRoundHandler<TResponse>;
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
) {
  if (timeoutMs <= 0) {
    return fn(new AbortController().signal);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function resolveInterval(intervalMs: number | (() => number)): number {
  return typeof intervalMs === "function" ? intervalMs() : intervalMs;
}

function createPoller<TResponse>(
  config: CreatePollerConfig<TResponse>
): PollerHandle {
  const { servers, fetchOne, onRound, intervalMs, requestTimeoutMs, jitterMs } =
    config;

  let runningPromise: Promise<void> | null = null;
  let shouldRun = false;
  const lifecycle = new AbortController();

  async function loop() {
    let round = 0;
    while (shouldRun) {
      round += 1;
      const startedAt = Date.now();

      if (jitterMs && jitterMs > 0) {
        const delay = Math.floor(Math.random() * (jitterMs + 1));
        await abortableSleep(delay, lifecycle.signal);
        if (!shouldRun) break;
      }

      const settled = await Promise.allSettled(
        servers.map((server) =>
          withTimeout(requestTimeoutMs, (signal) => fetchOne(server, signal))
        )
      );

      const success: TResponse[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled") {
          success.push(result.value);
        }
      }

      await onRound(success, {
        round,
        startedAt,
        servers: servers.slice(),
      });

      const elapsed = Date.now() - startedAt;
      const interval = resolveInterval(intervalMs);
      const waitFor = Math.max(0, interval - elapsed);
      if (waitFor > 0 && shouldRun) {
        await abortableSleep(waitFor, lifecycle.signal);
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
      lifecycle.abort();
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
        const handle = createPoller(config);
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
