import { Buffer } from "node:buffer";
import { Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LogsNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.Literal("logsNotification"),
    params: Type.Object(
      {
        result: Type.Object(
          {
            value: Type.Object(
              {
                err: Type.Union([Type.Null(), Type.Unknown()]),
                logs: Type.Array(Type.String()),
              },
              { additionalProperties: true }
            ),
          },
          { additionalProperties: true }
        ),
        subscription: Type.Optional(Type.Number()),
      },
      { additionalProperties: true }
    ),
  },
  { additionalProperties: true }
);

const SubscriptionResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: Type.Number(),
    result: Type.Number(),
  },
  { additionalProperties: true }
);

export type LogsNotification = Static<typeof LogsNotificationSchema>;
export type SubscriptionResponse = Static<typeof SubscriptionResponseSchema>;
export type LogsNotificationValue =
  LogsNotification["params"]["result"]["value"];

export type ParsedJsonRpcMessage =
  | { kind: "subscription"; id: number; result: number }
  | { kind: "logs"; value: LogsNotificationValue };

function parseJsonMessage(raw: unknown): unknown | null {
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  }
  if (ArrayBuffer.isView(raw)) {
    return JSON.parse(
      Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8")
    );
  }
  return null;
}

export function parseJsonRpcMessage(raw: unknown): ParsedJsonRpcMessage | null {
  const parsed = parseJsonMessage(raw);
  if (!parsed) {
    return null;
  }
  if (Value.Check(SubscriptionResponseSchema, parsed)) {
    return { kind: "subscription", id: parsed.id, result: parsed.result };
  }
  if (Value.Check(LogsNotificationSchema, parsed)) {
    return { kind: "logs", value: parsed.params.result.value };
  }
  return null;
}

export function createJsonRpcClient(send: (payload: string) => void) {
  let nextRequestId = 1;
  return {
    sendRequest(method: string, params?: unknown[]) {
      const id = nextRequestId++;
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        })
      );
      return id;
    },
  };
}
