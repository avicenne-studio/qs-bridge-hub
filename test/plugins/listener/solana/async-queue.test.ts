import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue } from "../../../../src/plugins/app/listener/solana/async-queue.js";

describe("async queue", () => {
  it("runs tasks sequentially", async () => {
    const queue = new AsyncQueue();
    const calls: number[] = [];

    await Promise.all([
      queue.push(async () => {
        calls.push(1);
      }),
      queue.push(async () => {
        calls.push(2);
      }),
    ]);

    assert.deepStrictEqual(calls, [1, 2]);
  });

  it("invokes the error handler for failed tasks", async () => {
    const errors: unknown[] = [];
    const queue = new AsyncQueue((error) => {
      errors.push(error);
    });

    await queue.push(async () => {
      throw new Error("boom");
    });

    assert.strictEqual(errors.length, 1);
  });

  it("swallows failures with the default handler", async () => {
    const queue = new AsyncQueue();
    await queue.push(async () => {
      throw new Error("boom");
    });
  });
});
