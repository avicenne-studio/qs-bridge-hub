import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import exponentialBackoffPlugin, {
  createWithBackoff,
  type WithBackoff,
  kExponentialBackoff,
  type ExponentialBackoffService,
} from "../../../src/plugins/infra/exponential-backoff.js";
import { build } from "../../helpers/build.js";

function fastBackoff(): WithBackoff {
  return createWithBackoff({
    maxRetries: 3,
    baseDelayMs: 1,
    maxDelayMs: 10,
  });
}

describe("exponential backoff", () => {
  it("returns on first success without retrying", async () => {
    const withBackoff = fastBackoff();
    let calls = 0;

    const result = await withBackoff(async () => {
      calls++;
      return "ok";
    });

    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const withBackoff = fastBackoff();
    let calls = 0;

    const result = await withBackoff(async () => {
      calls++;
      if (calls < 3) throw new Error(`fail-${calls}`);
      return "recovered";
    });

    assert.strictEqual(result, "recovered");
    assert.strictEqual(calls, 3);
  });

  it("throws the last error after exhausting retries", async () => {
    const withBackoff = fastBackoff();
    let calls = 0;

    await assert.rejects(
      withBackoff(async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      }),
      /fail-4/,
    );

    assert.strictEqual(calls, 4);
  });

  it("respects maxRetries override", async () => {
    const withBackoff = fastBackoff();
    let calls = 0;

    await assert.rejects(
      withBackoff(
        async () => {
          calls++;
          throw new Error("always fail");
        },
        { maxRetries: 1 },
      ),
      /always fail/,
    );

    assert.strictEqual(calls, 2);
  });

  it("aborts via signal when timeout is exceeded", async () => {
    const withBackoff = createWithBackoff({
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    await assert.rejects(
      withBackoff(
        async (signal) => {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
        },
        { timeoutMs: 10 },
      ),
      /aborted/,
    );
  });

  it("passes a valid AbortSignal to the function", async () => {
    const withBackoff = fastBackoff();
    let receivedSignal: AbortSignal | null = null;

    await withBackoff(async (signal) => {
      receivedSignal = signal;
      return "done";
    });

    assert.ok(receivedSignal !== null);
    const sig: AbortSignal = receivedSignal;
    assert.strictEqual(sig.aborted, false);
  });

  it("works without timeoutMs", async () => {
    const withBackoff = createWithBackoff({
      maxRetries: 1,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });
    let calls = 0;

    const result = await withBackoff(async () => {
      calls++;
      if (calls < 2) throw new Error("retry");
      return "ok";
    });

    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 2);
  });

  it("is available as a fastify decorator", async (t) => {
    const app = await build(t, { useMocks: false });
    const service = app.getDecorator<ExponentialBackoffService>(kExponentialBackoff);

    assert.ok(service);
    assert.strictEqual(typeof service.withBackoff, "function");
    assert.ok(service.defaults.maxRetries > 0);

    const result = await service.withBackoff(async () => "from-plugin");
    assert.strictEqual(result, "from-plugin");
  });

  it("skips registration when decorator already exists", async () => {
    const app = Fastify();
    await app.register(exponentialBackoffPlugin);
    await app.register(exponentialBackoffPlugin);
    await app.ready();

    const service = app.getDecorator<ExponentialBackoffService>(kExponentialBackoff);
    assert.ok(service);
    assert.strictEqual(typeof service.withBackoff, "function");

    await app.close();
  });
});
