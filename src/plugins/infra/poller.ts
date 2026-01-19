import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

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

export const RECOMMENDED_POLLING_DEFAULTS: Readonly<PollerOptions> =
  Object.freeze({
    intervalMs: 3000,
    requestTimeoutMs: 700,
    jitterMs: 25,
  });

export type PollerService = {
  create<TResponse>(config: CreatePollerConfig<TResponse>): PollerHandle;
};

export const kPoller = Symbol("infra.poller");

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
  const { servers, fetchOne, onRound, intervalMs, requestTimeoutMs, jitterMs } =
    config;

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
      for (const result of settled) {
        if (result.status === "fulfilled") {
          success.push(result.value);
        }
        // Promise.all rethrows on first failure. Promise.allSettled lets us
        // keep the successes even when some servers fail or time out.
      }

      await onRound(success, {
        round,
        startedAt,
        servers: servers.slice(),
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
    const handles = new Set<PollerHandle>();

    fastify.decorate(kPoller, {
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
