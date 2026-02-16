import { describe, it, TestContext } from "node:test";
import { AddressInfo } from "node:net";
import type { RequestListener } from "node:http";
import {
  type QubicEvent,
  kQubicEventFetcher,
} from "../../../../src/plugins/app/listener/qubic/qubic-event-poller.js";
import { createTrackedServer } from "../../../helpers/http-server.js";
import { kEventsRepository } from "../../../../src/plugins/app/events/events.repository.js";
import { createInMemoryEventsRepository } from "../../../helpers/solana-events.js";
import { waitFor } from "../../../helpers/wait-for.js";
import { build } from "../../../helpers/build.js";

function createQubicEvent(overrides: Partial<QubicEvent> = {}): QubicEvent {
  return {
    chain: "qubic",
    type: "lock",
    nonce: "1",
    payload: {
      fromAddress: "id(1,2,3,4)",
      toAddress: "id(4,3,2,1)",
      amount: "10",
      relayerFee: "1",
      nonce: "1",
    },
    trxHash: "trx-1",
    ...overrides,
  };
}

function createQubicUnlockEvent(overrides: Partial<QubicEvent> = {}): QubicEvent {
  return {
    chain: "qubic",
    type: "unlock",
    nonce: "9",
    payload: {
      toAddress: "id(9,9,9,9)",
      amount: "99",
      nonce: "9",
    },
    trxHash: "trx-unlock",
    ...overrides,
  };
}

function qubicJsonHandler(data: QubicEvent[]): RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
  };
}

function qubicArrayHandler(data: QubicEvent[]): RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
}

async function createQubicServer(t: TestContext, handler: RequestListener) {
  const server = createTrackedServer(handler);
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  t.after(() => server.close());
  return server.server.address() as AddressInfo;
}

describe("qubic poller plugin", () => {
  async function buildApp(
    t: TestContext,
    rpcUrl: string,
    eventsRepo = createInMemoryEventsRepository(),
    opts: { enabled?: boolean } = {},
  ) {
    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_POLLER_ENABLED: opts.enabled ?? true,
        QUBIC_RPC_URL: rpcUrl,
        QUBIC_POLLER_INTERVAL_MS: 10,
        QUBIC_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: eventsRepo,
      },
    });

    return { app, eventsRepo };
  }

  it("stores events from the qubic poller", async (t: TestContext) => {
    const { port } = await createQubicServer(t, qubicJsonHandler([
      createQubicEvent({ trxHash: "trx-1" }),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, "trx-1");
    t.assert.strictEqual(eventsRepo.store[0].chain, "qubic");
    t.assert.strictEqual(eventsRepo.store[0].type, "lock");
  });

  it("stores unlock events from the qubic poller", async (t: TestContext) => {
    const { port } = await createQubicServer(t, qubicJsonHandler([
      createQubicUnlockEvent({ trxHash: "trx-unlock-1" }),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, "trx-unlock-1");
    t.assert.strictEqual(eventsRepo.store[0].type, "unlock");
  });

  it("handles array responses from the qubic endpoint", async (t: TestContext) => {
    const { port } = await createQubicServer(t, qubicArrayHandler([
      createQubicEvent({ trxHash: "trx-array" }),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, "trx-array");
  });

  it("skips events missing transaction hash", async (t: TestContext) => {
    const { port } = await createQubicServer(t, qubicJsonHandler([
      createQubicEvent({ trxHash: undefined }),
    ]));

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("does nothing when QUBIC_POLLER_ENABLED is false", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createQubicServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });

    const { eventsRepo } = await buildApp(
      t,
      `http://127.0.0.1:${port}`,
      undefined,
      { enabled: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    t.assert.strictEqual(requestCount, 0);
    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("does not duplicate events across multiple rounds", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createQubicServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [createQubicEvent({ trxHash: "trx-stable" })] }));
    });

    const { eventsRepo } = await buildApp(t, `http://127.0.0.1:${port}`);

    await waitFor(() => requestCount >= 3);

    const matches = eventsRepo.store.filter((e) => e.signature === "trx-stable");
    t.assert.strictEqual(matches.length, 1);
  });

  it("logs when payload is invalid", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createQubicServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ nope: true }] }));
    });

    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_POLLER_ENABLED: true,
        QUBIC_RPC_URL: `http://127.0.0.1:${port}`,
        QUBIC_POLLER_INTERVAL_MS: 10,
        QUBIC_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: createInMemoryEventsRepository(),
      },
    });

    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await waitFor(() => requestCount >= 2);

    t.assert.ok(
      warnMock.calls.some(
        (call) => call.arguments[1] === "qubic events poll returned invalid payload",
      ),
    );
  });

  it("logs when payload is not an object", async (t: TestContext) => {
    let requestCount = 0;
    const { port } = await createQubicServer(t, (_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify("bad-payload"));
    });

    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_POLLER_ENABLED: true,
        QUBIC_RPC_URL: `http://127.0.0.1:${port}`,
        QUBIC_POLLER_INTERVAL_MS: 10,
        QUBIC_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: createInMemoryEventsRepository(),
      },
    });

    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await waitFor(() => requestCount >= 2);

      t.assert.ok(
      warnMock.calls.some(
        (call) => call.arguments[1] === "qubic events poll returned invalid payload",
      ),
    );
  });

  it("logs when fetcher throws and keeps running", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_POLLER_ENABLED: true,
        QUBIC_RPC_URL: "http://unused",
        QUBIC_POLLER_INTERVAL_MS: 10,
        QUBIC_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: eventsRepo,
        [kQubicEventFetcher]: async () => {
          throw new Error("boom");
        },
      },
    });

    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await waitFor(() =>
      warnMock.calls.some(
        (call) => call.arguments[1] === "qubic events poll failed",
      ),
    );

    t.assert.strictEqual(eventsRepo.store.length, 0);
  });

  it("uses custom fetcher when decorated", async (t: TestContext) => {
    const eventsRepo = createInMemoryEventsRepository();
    await build(t, {
      useMocks: false,
      config: {
        QUBIC_POLLER_ENABLED: true,
        QUBIC_RPC_URL: "http://unused",
        QUBIC_POLLER_INTERVAL_MS: 10,
        QUBIC_POLLER_TIMEOUT_MS: 1000,
        ORACLE_URLS: "",
      },
      decorators: {
        [kEventsRepository]: eventsRepo,
        [kQubicEventFetcher]: async () =>
          ({ data: [createQubicEvent({ trxHash: "trx-custom" })] } as unknown as QubicEvent[]),
      },
    });

    await waitFor(() => eventsRepo.store.length >= 1);

    t.assert.strictEqual(eventsRepo.store[0].signature, "trx-custom");
  });
});
