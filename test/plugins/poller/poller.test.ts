import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../helper.js";

const noop = () => {};

describe("poller plugin", () => {
  it("collects only successful responses per round", async (t) => {
    const app = await build(t);

    const servers = ["ok-1", "ok-2", "fail"] as const;
    const responsesByServer = new Map([
      ["ok-1", ["ok-1-r1", "ok-1-r2"]],
      ["ok-2", ["ok-2-r1", "ok-2-r2"]],
    ]);

    const pollResults: string[][] = [];
    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const fetcher = async (server: string) => {
      if (server === "fail") throw new Error("boom");

      const bucket = responsesByServer.get(server)!;
      const value = bucket.shift()!;
      return value;
    };

    const poller = app.poller.create({
      servers,
      fetcher: (s: string) => fetcher(s),
      onRound: (responses, context) => {
        pollResults.push(responses);

        if (context.round === 2) {
          // Do not await stop inside onRound. Stop after onRound returns.
          queueMicrotask(() => {
            poller.stop().then(() => done?.(), noop);
          });
        }
      },
      intervalMs: 5,
      requestTimeoutMs: 10,
      jitterMs: 15,
    });

    poller.start();
    await completion;

    assert.deepStrictEqual(pollResults, [
      ["ok-1-r1", "ok-2-r1"],
      ["ok-1-r2", "ok-2-r2"],
    ]);
    assert.strictEqual(poller.isRunning(), false);
  });

  it("aborts slow servers and exposes defaults", async (t) => {
    const app = await build(t);

    const abortedServers: string[] = [];
    const servers = ["slow", "fast"];

    const fetcher = (server: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        if (server === "fast") {
          resolve("fast-response");
          return;
        }

        const onAbort = () => {
          abortedServers.push(server);
          signal.removeEventListener("abort", onAbort);
          reject(new Error("aborted"));
        };

        signal.addEventListener("abort", onAbort);
      });

    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const poller = app.poller.create({
      servers,
      fetcher,
      onRound: (responses) => {
        assert.deepStrictEqual(responses, ["fast-response"]);
        queueMicrotask(() => {
          poller.stop().then(() => done?.(), noop);
        });
      },
      intervalMs: 5,
      requestTimeoutMs: 10,
      jitterMs: 0,
    });

    assert.deepStrictEqual(app.poller.defaults, {
      intervalMs: 1000,
      requestTimeoutMs: 700,
      jitterMs: 25,
    });

    poller.start();
    await completion;

    assert.deepStrictEqual(abortedServers, ["slow"]);
    await poller.stop().catch(noop);
  });

  it("throws when start is invoked twice", async (t) => {
    const app = await build(t);

    const poller = app.poller.create({
      servers: ["s1"],
      fetcher: async () => "ok",
      onRound: noop,
      intervalMs: 1,
      requestTimeoutMs: 10,
      jitterMs: 0,
    });

    poller.start();
    assert.throws(() => poller.start(), /already started/);
    await poller.stop();
  });
});
