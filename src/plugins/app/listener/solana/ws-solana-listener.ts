import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { WebSocket } from "undici";
import { AsyncQueue } from "./async-queue.js";
import {
  decodeEventBytes,
  isKnownEventSize,
  logLinesToEvents,
} from "./solana-program-logs.js";
import { createSolanaEventHandlers } from "./solana-events.js";
import {
  createJsonRpcClient,
  parseJsonRpcMessage,
} from "./solana-ws-json-rpc.js";
import { kConfig, type AppConfig } from "../../../infra/env.js";
import {
  kEventsRepository,
  type EventsRepository,
} from "../../events/events.repository.js";

const QS_BRIDGE_PROGRAM_ADDRESS =
  "qSBGtee9tspoDVmb867Wq6tcR3kp19XN1PbBVckrH7H";

type WebSocketListener = (event: { data?: unknown }) => void;

type WebSocketLike = {
  addEventListener(type: string, listener: WebSocketListener): void;
  removeEventListener(type: string, listener: WebSocketListener): void;
  send(payload: string): void;
  close(): void;
  readyState: number;
};

type WebSocketFactory = (url: string) => WebSocketLike;

type SolanaWsFactoryOwner = {
  solanaWsFactory?: WebSocketFactory;
  parent?: SolanaWsFactoryOwner;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractSignatureSlot(value: unknown) {
  if (!isObject(value)) {
    return { signature: undefined, slot: undefined };
  }
  const signature =
    typeof value.signature === "string" ? value.signature : undefined;
  const slot = typeof value.slot === "number" ? value.slot : undefined;
  return { signature, slot };
}

export function extractErrorMetadata(event: unknown) {
  if (!isObject(event)) {
    return { reason: undefined, code: undefined };
  }
  const reason = typeof event.reason === "string" ? event.reason : undefined;
  const code = typeof event.code === "number" ? event.code : undefined;
  return { reason, code };
}

function isInboundProcessing(logs: string[]): boolean {
  return logs.some((line) =>
    line.includes("QS-BRIDGE: Processing inbound order")
  );
}

export function createDefaultSolanaWsFactory(
  WebSocketCtor: typeof WebSocket = WebSocket
): WebSocketFactory {
  return (url: string) => new WebSocketCtor(url) as WebSocketLike;
}

export function resolveSolanaWsFactory(
  instance: SolanaWsFactoryOwner,
  defaultFactory: WebSocketFactory
): WebSocketFactory {
  return (
    instance.solanaWsFactory ??
    instance.parent?.solanaWsFactory ??
    defaultFactory
  );
}

export default fp(
  async function wsSolanaListener(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    if (!config.SOLANA_LISTENER_ENABLED) {
      fastify.log.info("Solana WS listener disabled by configuration");
      return;
    }

    const eventsRepository =
      fastify.getDecorator<EventsRepository>(kEventsRepository);
    let ws: WebSocketLike | null = null;
    let wsUrl: string | null = null;
    let wsFactory: WebSocketFactory | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let shuttingDown = false;
    let subscriptionId: number | null = null;
    const queue = new AsyncQueue((error) => {
      fastify.log.error({ err: error }, "Solana listener async task failed");
    });
    const rpc = createJsonRpcClient((payload) => {
      if (ws) {
        ws.send(payload);
      }
    });

    let subscribeRequestId: number | null = null;
    const seenUnknownEventSizes = new Set<number>();
    const { handleOutboundEvent, handleOverrideOutboundEvent } =
      createSolanaEventHandlers({
        eventsRepository,
        logger: fastify.log,
      });

    const sendRequest = (method: string, params?: unknown[]) =>
      rpc.sendRequest(method, params);

    const onMessage = (event: { data?: unknown }) => {
      let parsed;
      try {
        parsed = parseJsonRpcMessage(event.data);
      } catch (error) {
        fastify.log.warn({ err: error }, "Solana listener received bad JSON");
        return;
      }
      if (!parsed) {
        return;
      }

      if (parsed.kind === "subscription") {
        if (parsed.id === subscribeRequestId) {
          subscriptionId = parsed.result;
          fastify.log.info(
            { subscriptionId },
            "Solana listener subscription established"
          );
        }
        return;
      }

      const { signature, slot } = extractSignatureSlot(parsed.value);
      fastify.log.debug(
        {
          signature,
          slot,
          hasError: Boolean(parsed.value.err),
          logCount: parsed.value.logs.length,
        },
        "Solana logs notification received"
      );
      fastify.log.debug(
        { signature, logs: parsed.value.logs.slice(0, 6) },
        "Solana logs (sample)"
      );

      if (parsed.value.err) {
        fastify.log.warn(
          { signature, err: parsed.value.err },
          "Solana logs notification has error"
        );
        return;
      }

      if (isInboundProcessing(parsed.value.logs)) {
        fastify.log.info(
          { signature, slot },
          "Solana inbound transaction ignored"
        );
        return;
      }

      const dataLogs = logLinesToEvents(parsed.value.logs);
      fastify.log.debug(
        { signature, dataLogCount: dataLogs.length },
        "Solana logs decoded to program data entries"
      );
      for (const data of dataLogs) {
        const decoded = decodeEventBytes(data);
        if (!decoded) {
          if (!isKnownEventSize(data.length)) {
            if (!seenUnknownEventSizes.has(data.length)) {
              seenUnknownEventSizes.add(data.length);
              fastify.log.warn(
                { size: data.length, signature },
                "Solana listener received unknown event size"
              );
            }
          }
          continue;
        }

        void queue.push(async () => {
          try {
            if (decoded.type === "outbound") {
              fastify.log.info(
                { signature, type: decoded.type },
                "Solana outbound event received"
              );
              await handleOutboundEvent(decoded.event, { signature, slot });
            } else if (decoded.type === "override-outbound") {
              fastify.log.info(
                { signature, type: decoded.type },
                "Solana override outbound event received"
              );
              await handleOverrideOutboundEvent(decoded.event, { signature, slot });
            }
          } catch (error) {
            fastify.log.error(
              { err: error },
              "Solana listener failed to process event"
            );
            throw error;
          }
        });
      }
    };

    const onOpen = () => {
      subscribeRequestId = sendRequest("logsSubscribe", [
        { mentions: [QS_BRIDGE_PROGRAM_ADDRESS] },
        { commitment: "confirmed" },
      ]);
      reconnectAttempt = 0;
      fastify.log.info({ wsUrl }, "Solana listener WebSocket connected");
    };

    const onError = (event: { data?: unknown }) => {
      const errorMeta = extractErrorMetadata(event);
      fastify.log.error(
        {
          event,
          wsUrl,
          readyState: ws?.readyState,
          reason: errorMeta.reason,
          code: errorMeta.code,
        },
        "Solana listener WebSocket error"
      );
    };

    const scheduleReconnect = () => {
      if (shuttingDown) {
        return;
      }
      if (reconnectTimer) {
        return;
      }
      const delayMs = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!wsUrl || !wsFactory) {
          return;
        }
        fastify.log.warn({ wsUrl, delayMs }, "Reconnecting Solana WS");
        ws = wsFactory(wsUrl);
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
      }, delayMs);
    };

    const onClose = () => {
      fastify.log.warn(
        {
          wsUrl,
          readyState: ws?.readyState,
        },
        "Solana listener WebSocket closed"
      );
      subscriptionId = null;
      scheduleReconnect();
    };

    fastify.addHook("onReady", async () => {
      const instance = fastify as FastifyInstance & {
        solanaWsFactory?: WebSocketFactory;
        parent?: FastifyInstance & { solanaWsFactory?: WebSocketFactory };
      };
      wsFactory = resolveSolanaWsFactory(
        instance,
        createDefaultSolanaWsFactory()
      );
      wsUrl = config.SOLANA_WS_URL;
      ws = wsFactory(wsUrl);
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });

    fastify.addHook("onClose", async () => {
      shuttingDown = true;
      if (!ws) {
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);

      if (subscriptionId !== null && ws.readyState === WebSocket.OPEN) {
        sendRequest("logsUnsubscribe", [subscriptionId]);
      }

      ws.close();
      ws = null;
    });
  },
  {
    name: "ws-solana-listener",
    dependencies: ["env", "events-repository"],
  }
);
