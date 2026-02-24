import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { sleep } from "./poller.js";

export type BackoffOptions = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs?: number;
};

const DEFAULT_OPTIONS: Readonly<BackoffOptions> = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
});

export type WithBackoff = <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options?: Partial<BackoffOptions>,
) => Promise<T>;

export type ExponentialBackoffService = {
  defaults: Readonly<BackoffOptions>;
  withBackoff: WithBackoff;
};

export const kExponentialBackoff = Symbol("infra.exponentialBackoff");

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

export function createWithBackoff(
  defaults: Readonly<BackoffOptions>,
): WithBackoff {
  return async function withBackoff<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: Partial<BackoffOptions>,
  ): Promise<T> {
    const opts = { ...defaults, ...options };
    let lastError: unknown;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      }

      try {
        return await fn(controller.signal);
      } catch (err) {
        lastError = err;
        if (attempt < opts.maxRetries) {
          await sleep(computeDelay(attempt, opts.baseDelayMs, opts.maxDelayMs));
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    throw lastError;
  };
}

export default fp(
  function exponentialBackoffPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kExponentialBackoff)) {
      return;
    }

    const withBackoff = createWithBackoff(DEFAULT_OPTIONS);

    fastify.decorate(kExponentialBackoff, {
      defaults: DEFAULT_OPTIONS,
      withBackoff,
    });
  },
  {
    name: "exponential-backoff",
  },
);
