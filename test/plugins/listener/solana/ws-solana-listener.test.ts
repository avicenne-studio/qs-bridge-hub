import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import wsSolanaListener, {
  createDefaultSolanaWsFactory,
  extractErrorMetadata,
  extractSignatureSlot,
  isObject,
  resolveSolanaWsFactory,
} from "../../../../src/plugins/app/listener/solana/ws-solana-listener.js";
import { waitFor } from "../../../helpers/wait-for.js";
import { getInboundEventEncoder } from "../../../../src/clients/js/types/inboundEvent.js";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";
import { kConfig } from "../../../../src/plugins/infra/env.js";
import {
  kEventsRepository,
} from "../../../../src/plugins/app/events/events.repository.js";

type WsEventMap = {
  open: Record<string, never>;
  close: Record<string, never>;
  error: { data?: unknown };
  message: { data?: unknown };
};

type WsEventHandler = (event: WsEventMap[keyof WsEventMap]) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  url?: string;
  private readonly keepListeners: boolean;
  private listeners = new Map<keyof WsEventMap, Set<WsEventHandler>>();

  constructor({ keepListeners = false }: { keepListeners?: boolean } = {}) {
    this.keepListeners = keepListeners;
  }

  addEventListener<K extends keyof WsEventMap>(
    type: K,
    listener: (event: WsEventMap[K]) => void
  ) {
    const bucket = this.listeners.get(type) ?? new Set<WsEventHandler>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener<K extends keyof WsEventMap>(
    type: K,
    listener: (event: WsEventMap[K]) => void
  ) {
    if (this.keepListeners) {
      return;
    }
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    bucket.delete(listener);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  emit<K extends keyof WsEventMap>(type: K, event: WsEventMap[K]) {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    for (const handler of bucket) {
      handler(event);
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }
}

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return new Uint8Array(
    encoder.encode({
      discriminator: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: new Uint8Array(32).fill(1),
      tokenOut: new Uint8Array(32).fill(2),
      fromAddress: new Uint8Array(32).fill(3),
      toAddress: new Uint8Array(32).fill(4),
      amount: 10n,
      relayerFee: 2n,
      nonce,
    })
  );
}

function createOverrideEventBytes() {
  const encoder = getOverrideOutboundEventEncoder();
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return new Uint8Array(
    encoder.encode({
      discriminator: 2,
      toAddress: new Uint8Array(32).fill(9),
      relayerFee: 7n,
      nonce,
    })
  );
}

function createInboundEventBytes() {
  const encoder = getInboundEventEncoder();
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return new Uint8Array(
    encoder.encode({
      discriminator: 0,
      networkIn: 1,
      networkOut: 2,
      tokenIn: new Uint8Array(32).fill(1),
      tokenOut: new Uint8Array(32).fill(2),
      fromAddress: new Uint8Array(32).fill(3),
      toAddress: new Uint8Array(32).fill(4),
      amount: 10n,
      relayerFee: 2n,
      nonce,
    })
  );
}

function createLogsNotification(
  lines: string[],
  signature?: string,
  slot?: number
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      result: {
        value: { err: null, logs: lines, signature, slot },
      },
    },
  });
}

function createInMemoryEvents() {
  const store: Array<{
    id: number;
    signature: string;
    slot: number | null;
    chain: "solana";
    type: "outbound" | "override-outbound";
    nonce: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }> = [];
  let nextId = 1;
  return {
    store,
    async create(event: {
      signature: string;
      slot: number | null;
      chain: "solana";
      type: "outbound" | "override-outbound";
      nonce: string;
      payload: Record<string, unknown>;
    }) {
      const created = {
        id: nextId++,
        createdAt: new Date().toISOString(),
        ...event,
      };
      store.push(created);
      return created;
    },
    async listAfter(afterId: number, limit: number) {
      return store.filter((event) => event.id > afterId).slice(0, limit);
    },
  };
}

type ListenerAppOptions = {
  enabled?: boolean;
  ws?: MockWebSocket;
  wsFactory?: (url: string) => MockWebSocket;
  eventsRepository?: ReturnType<typeof createInMemoryEvents>;
  wsUrl?: string;
  fallbackWsUrl?: string;
};

async function buildListenerApp({
  enabled = true,
  ws = new MockWebSocket(),
  wsFactory,
  eventsRepository = createInMemoryEvents(),
  wsUrl = "ws://localhost:8900",
  fallbackWsUrl = "ws://fallback:8900",
}: ListenerAppOptions = {}) {
  const app = fastify({ logger: false });

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kConfig, {
          SOLANA_LISTENER_ENABLED: enabled,
          SOLANA_WS_URL: wsUrl,
          SOLANA_FALLBACK_WS_URL: fallbackWsUrl,
          PORT: 3000,
          HOST: "127.0.0.1",
          RATE_LIMIT_MAX: 100,
          SQLITE_DB_FILE: ":memory:",
          ORACLE_URLS: "http://localhost:3001",
          ORACLE_SIGNATURE_THRESHOLD: 2,
          HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
        });
      },
      { name: "env" }
    )
  );

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kEventsRepository, eventsRepository);
      },
      { name: "events-repository" }
    )
  );

  app.decorate("solanaWsFactory", wsFactory ?? (() => ws));
  app.register(wsSolanaListener);
  await app.ready();

  return { app, ws, eventsRepository };
}

describe("ws solana listener plugin", () => {
  it("handles non-object metadata helpers", () => {
    assert.strictEqual(isObject(null), false);
    assert.deepStrictEqual(extractSignatureSlot("nope"), {
      signature: undefined,
      slot: undefined,
    });
    assert.deepStrictEqual(extractErrorMetadata("nope"), {
      reason: undefined,
      code: undefined,
    });
    assert.deepStrictEqual(extractErrorMetadata({ reason: "boom", code: 42 }), {
      reason: "boom",
      code: 42,
    });
  });

  it("skips initialization when disabled", async () => {
    let created = 0;
    const ws = new MockWebSocket();
    const app = fastify({ logger: false });

    app.register(
      fp(async (instance) => {
        instance.decorate(kConfig, {
          SOLANA_LISTENER_ENABLED: false,
          SOLANA_WS_URL: "ws://localhost:8900",
          PORT: 3000,
          HOST: "127.0.0.1",
          RATE_LIMIT_MAX: 100,
          SQLITE_DB_FILE: ":memory:",
          ORACLE_URLS: "http://localhost:3001",
          ORACLE_SIGNATURE_THRESHOLD: 2,
          HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
        });
      }, { name: "env" })
    );
    app.register(
      fp(async (instance) => {
        instance.decorate(kEventsRepository, createInMemoryEvents());
      }, { name: "events-repository" })
    );
    app.decorate("solanaWsFactory", () => {
      created += 1;
      return ws;
    });

    app.register(wsSolanaListener);
    await app.ready();
    await app.close();

    assert.strictEqual(created, 0);
  });

  it("subscribes and unsubscribes via json-rpc", async () => {
    const { app, ws } = await buildListenerApp();

    ws.emit("open", {});
    const subscribe = JSON.parse(ws.sent[0]);
    assert.strictEqual(subscribe.method, "logsSubscribe");
    ws.emit(
      "message",
      {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: subscribe.id,
          result: 55,
        }),
      }
    );

    await app.close();

    const unsubscribe = ws.sent.find((payload) =>
      payload.includes("logsUnsubscribe")
    );
    assert.ok(unsubscribe);
    const parsed = JSON.parse(unsubscribe);
    assert.deepStrictEqual(parsed.params, [55]);
  });

  it("handles shutdown before ws initialization", async () => {
    const app = fastify({ logger: false });
    app.register(
      fp(async (instance) => {
        instance.decorate(kConfig, {
          SOLANA_LISTENER_ENABLED: true,
          SOLANA_WS_URL: "ws://localhost:8900",
          PORT: 3000,
          HOST: "127.0.0.1",
          RATE_LIMIT_MAX: 100,
          SQLITE_DB_FILE: ":memory:",
          ORACLE_URLS: "http://localhost:3001",
          ORACLE_SIGNATURE_THRESHOLD: 2,
          HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
        });
      }, { name: "env" })
    );
    app.register(
      fp(async (instance) => {
        instance.decorate(kEventsRepository, createInMemoryEvents());
      }, { name: "events-repository" })
    );
    app.register(wsSolanaListener);

    await app.close();
  });

  it("logs queue errors from async tasks", async (t) => {
    const repo = createInMemoryEvents();
    repo.create = async () => {
      throw new Error("queue-fail");
    };
    const { app, ws } = await buildListenerApp({
      eventsRepository: repo,
    });
    const { mock: logMock } = t.mock.method(app.log, "error");

    ws.emit("open", {});

    const outboundBytes = createOutboundEventBytes();
    const payload = createLogsNotification([
      `Program data: ${Buffer.from(outboundBytes).toString("base64")}`,
    ], "sig-queue");
    ws.emit("message", { data: payload });

    await waitFor(() => {
      const hasAsyncLog = logMock.calls.some(
        (call) => call.arguments[1] === "Solana listener async task failed"
      );
      const hasProcessLog = logMock.calls.some(
        (call) => call.arguments[1] === "Solana listener failed to process event"
      );
      return hasAsyncLog && hasProcessLog;
    });

    await app.close();
  });

  it("clears subscription state on close events", async () => {
    const { app, ws } = await buildListenerApp();

    ws.emit("open", {});
    const subscribe = JSON.parse(ws.sent[0]);
    ws.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: subscribe.id,
        result: 55,
      }),
    });
    ws.emit("close", {});

    await app.close();
  });

  it("processes outbound and override events", async () => {
    const { app, ws, eventsRepository } = await buildListenerApp();

    ws.emit("open", {});

    const outboundBytes = createOutboundEventBytes();
    const overrideBytes = createOverrideEventBytes();
    const payload = createLogsNotification([
      `Program data: ${Buffer.from(outboundBytes).toString("base64")}`,
      `Program data: ${Buffer.from(overrideBytes).toString("base64")}`,
      `Program data: ${Buffer.from(new Uint8Array(12)).toString("base64")}`,
      `Program data: ${Buffer.from(new Uint8Array(12)).toString("base64")}`,
    ], "sig-process", 99);

    ws.emit("message", { data: payload });
    ws.emit(
      "message",
      { data: JSON.stringify({ jsonrpc: "2.0", method: "ping" }) }
    );
    ws.emit(
      "message",
      {
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: { result: { value: { err: "boom", logs: [] } } },
        }),
      }
    );
    ws.emit("error", { data: "boom" });
    ws.emit("message", { data: "{bad json" });

    await waitFor(() =>
      eventsRepository.store.some((event) => event.signature === "sig-process")
    );

    assert.strictEqual(eventsRepository.store.length, 2);
    assert.strictEqual(eventsRepository.store[1].type, "override-outbound");

    await app.close();
  });

  it("skips inbound transactions", async () => {
    const { app, ws, eventsRepository } = await buildListenerApp();

    ws.emit("open", {});

    const inboundBytes = createInboundEventBytes();
    const payload = createLogsNotification(
      [
        `Program data: ${Buffer.from(inboundBytes).toString("base64")}`,
      ],
      "sig-inbound",
      42
    );

    ws.emit("message", { data: payload });

    await waitFor(() => ws.sent.length > 0);

    assert.strictEqual(eventsRepository.store.length, 0);

    await app.close();
  });

  it("logs missing signature and skips storage", async (t) => {
    const { app, ws, eventsRepository } = await buildListenerApp();
    const { mock: warnMock } = t.mock.method(app.log, "warn");

    ws.emit("open", {});
    const outboundBytes = createOutboundEventBytes();
    const payload = createLogsNotification([
      `Program data: ${Buffer.from(outboundBytes).toString("base64")}`,
    ]);
    ws.emit("message", { data: payload });

    await waitFor(() => warnMock.calls.length > 0);
    assert.strictEqual(eventsRepository.store.length, 0);

    await app.close();
  });

  it("logs missing signature for override events", async (t) => {
    const { app, ws, eventsRepository } = await buildListenerApp();
    const { mock: warnMock } = t.mock.method(app.log, "warn");

    ws.emit("open", {});
    const overrideBytes = createOverrideEventBytes();
    const payload = createLogsNotification([
      `Program data: ${Buffer.from(overrideBytes).toString("base64")}`,
    ]);
    ws.emit("message", { data: payload });

    await waitFor(() =>
      warnMock.calls.some(
        (call) =>
          call.arguments[0] === "Solana override event missing transaction signature"
      )
    );
    assert.strictEqual(eventsRepository.store.length, 0);

    await app.close();
  });

  it("resolves factories with explicit overrides", () => {
    class FakeWebSocket {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    }

    type DefaultFactoryArg = Parameters<typeof createDefaultSolanaWsFactory>[0];
    type ResolveInput = Parameters<typeof resolveSolanaWsFactory>[0];

    const defaultFactory = createDefaultSolanaWsFactory(
      FakeWebSocket as unknown as DefaultFactoryArg
    );
    const override = () => new MockWebSocket();
    const resolved = resolveSolanaWsFactory(
      { solanaWsFactory: override } as ResolveInput,
      defaultFactory
    );
    assert.strictEqual(resolved, override);

    const parentFactory = () => new MockWebSocket();
    const resolvedParent = resolveSolanaWsFactory(
      { parent: { solanaWsFactory: parentFactory } } as ResolveInput,
      defaultFactory
    );
    assert.strictEqual(resolvedParent, parentFactory);

    const resolvedDefault = resolveSolanaWsFactory(
      {} as ResolveInput,
      defaultFactory
    );
    assert.strictEqual(resolvedDefault, defaultFactory);

    const fromDefault = defaultFactory("ws://example.test");
    assert.ok(fromDefault instanceof FakeWebSocket);
  });

  it("reconnects after close events", async (t) => {
    const sockets: MockWebSocket[] = [];
    const factory = () => {
      const socket = new MockWebSocket();
      sockets.push(socket);
      return socket;
    };
    const { app } = await buildListenerApp({ wsFactory: factory });
    let reconnected = false;
    t.mock.method(global, "setTimeout", (fn: () => void) => {
      if (fn.name !== "retryPrimaryWebSocket") {
        reconnected = true;
        fn();
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    const first = sockets[0];
    assert.ok(first);
    first.emit("close", {});

    assert.ok(reconnected);
    await waitFor(() => sockets.length === 2);
    await app.close();
  });

  it("avoids duplicate reconnect timers", async (t) => {
    const sockets: MockWebSocket[] = [];
    const factory = () => {
      const socket = new MockWebSocket();
      sockets.push(socket);
      return socket;
    };
    const { app } = await buildListenerApp({ wsFactory: factory });
    let reconnectScheduled = 0;
    t.mock.method(global, "setTimeout", (fn: () => void) => {
      if (fn.name !== "retryPrimaryWebSocket") {
        reconnectScheduled += 1;
        fn();
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    const first = sockets[0];
    assert.ok(first);
    first.emit("close", {});
    first.emit("close", {});

    assert.strictEqual(reconnectScheduled, 1);
    await waitFor(() => sockets.length === 2);
    await app.close();
  });

  it("skips reconnect when shutting down", async () => {
    const sockets: MockWebSocket[] = [];
    const factory = () => {
      const socket = new MockWebSocket({ keepListeners: true });
      sockets.push(socket);
      return socket;
    };
    const { app } = await buildListenerApp({ wsFactory: factory });
    const first = sockets[0];
    assert.ok(first);
    await app.close();
    first.emit("close", {});
    assert.strictEqual(sockets.length, 1);
  });

  it("skips reconnect when ws url is empty", async (t) => {
    const sockets: MockWebSocket[] = [];
    const factory = () => {
      const socket = new MockWebSocket();
      sockets.push(socket);
      return socket;
    };
    const { app } = await buildListenerApp({
      wsFactory: factory,
      wsUrl: "",
    });
    t.mock.method(global, "setTimeout", (fn: () => void) => {
      fn();
      return 1 as unknown as NodeJS.Timeout;
    });

    const first = sockets[0];
    assert.ok(first);
    first.emit("close", {});
    assert.strictEqual(sockets.length, 1);
    await app.close();
  });

  it("switches to fallback on first failure and back to primary after 60s", async (t) => {
    const connections: { url: string; socket: MockWebSocket }[] = [];
    const factory = (url: string) => {
      const socket = new MockWebSocket();
      socket.url = url;
      connections.push({ url, socket });
      return socket;
    };

    const { app } = await buildListenerApp({
      wsFactory: factory,
      wsUrl: "ws://primary:8900",
      fallbackWsUrl: "ws://fallback:8900",
    });

    let fallbackTimerFn: (() => void) | null = null;
    let reconnectFn: (() => void) | null = null;
    t.mock.method(global, "setTimeout", (fn: () => void) => {
      if (fn.name === "retryPrimaryWebSocket") {
        fallbackTimerFn = fn;
      } else {
        reconnectFn = fn;
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    assert.strictEqual(connections[0].url, "ws://primary:8900");

    connections[0].socket.emit("close", {});
    assert.ok(reconnectFn);
    (reconnectFn as () => void)();

    assert.strictEqual(connections.length, 2);
    assert.strictEqual(connections[1].url, "ws://fallback:8900");

    assert.ok(fallbackTimerFn);
    (fallbackTimerFn as () => void)();
    assert.ok(reconnectFn);
    (reconnectFn as () => void)();

    assert.strictEqual(connections.length, 3);
    assert.strictEqual(connections[2].url, "ws://primary:8900");

    await app.close();
  });
});
