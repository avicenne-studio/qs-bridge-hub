import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createJsonRpcClient,
  parseJsonRpcMessage,
} from "../../../../src/plugins/app/listener/solana/solana-ws-json-rpc.js";

describe("solana ws json-rpc helpers", () => {
  it("parses subscription responses", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: 42,
    });
    const parsed = parseJsonRpcMessage(payload);
    assert.deepStrictEqual(parsed, { kind: "subscription", id: 3, result: 42 });
  });

  it("parses log notifications from multiple payload shapes", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        result: {
          value: { err: null, logs: ["a", "b"] },
        },
      },
    });

    const parsed = parseJsonRpcMessage(payload);
    assert.deepStrictEqual(parsed, {
      kind: "logs",
      value: { err: null, logs: ["a", "b"] },
    });

    const encoder = new TextEncoder();
    const buffer = encoder.encode(payload);
    const parsedView = parseJsonRpcMessage(buffer);
    assert.ok(parsedView && parsedView.kind === "logs");

    const parsedBuffer = parseJsonRpcMessage(buffer.buffer);
    assert.ok(parsedBuffer && parsedBuffer.kind === "logs");
  });

  it("returns null for irrelevant messages", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "ping" });
    assert.strictEqual(parseJsonRpcMessage(payload), null);
    assert.strictEqual(parseJsonRpcMessage(123 as unknown as string), null);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseJsonRpcMessage("{bad json"));
  });

  it("sends requests with incrementing ids", () => {
    const sent: string[] = [];
    const client = createJsonRpcClient((payload) => sent.push(payload));
    const first = client.sendRequest("logsSubscribe", []);
    const second = client.sendRequest("logsUnsubscribe", [1]);

    assert.strictEqual(first, 1);
    assert.strictEqual(second, 2);
    assert.strictEqual(sent.length, 2);
    assert.ok(sent[0].includes("\"id\":1"));
    assert.ok(sent[1].includes("\"id\":2"));
  });
});
