import { describe, it, TestContext } from "node:test";
import { createServer } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { build } from "../../helpers/build.js";
import {
  kPoller,
  type PollerService,
} from "../../../src/plugins/infra/poller.js";
import {
  kUndiciClient,
  type UndiciClientService,
} from "../../../src/plugins/infra/undici-client.js";

const noop = () => {};

const socketsByServer = new WeakMap<ReturnType<typeof createServer>, Set<Socket>>();

function trackServer(server: ReturnType<typeof createServer>) {
  const sockets = new Set<Socket>();
  socketsByServer.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return server;
}

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve) => {
    for (const socket of socketsByServer.get(server) ?? []) {
      socket.destroy();
    }
    server.close(() => resolve());
  });
}

describe("poller plugin", () => {
  it("collects only successful responses per round", async (t: TestContext) => {
    const app = await build(t);
    const pollerService = app.getDecorator<PollerService>(kPoller);

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

    const fetchOne = async (server: string) => {
      if (server === "fail") throw new Error("boom");

      const bucket = responsesByServer.get(server)!;
      const value = bucket.shift()!;
      return value;
    };

    const poller = pollerService.create({
      servers,
      fetchOne: (s: string) => fetchOne(s),
      onRound: (responses, context) => {
        pollResults.push(responses);

        if (context.round === 2) {
          // Do not await stop inside onRound. Stop after onRound returns.
          queueMicrotask(() => {
            poller.stop().then(() => done?.(), noop);
          });
        }
      },
      intervalMs: 50,
      requestTimeoutMs: 10,
      jitterMs: 15,
    });

    poller.start();
    await completion;

    t.assert.deepStrictEqual(pollResults, [
      ["ok-1-r1", "ok-2-r1"],
      ["ok-1-r2", "ok-2-r2"],
    ]);
    t.assert.strictEqual(poller.isRunning(), false);
  });

  it("aborts slow servers and exposes defaults", async (t: TestContext) => {
    const app = await build(t);
    const pollerService = app.getDecorator<PollerService>(kPoller);

    const abortedServers: string[] = [];
    const servers = ["slow", "fast"];

    const fetchOne = (server: string, signal: AbortSignal) =>
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

    const poller = pollerService.create({
      servers,
      fetchOne,
      onRound: (responses) => {
        t.assert.deepStrictEqual(responses, ["fast-response"]);
        queueMicrotask(() => {
          poller.stop().then(() => done?.(), noop);
        });
      },
      intervalMs: 5,
      requestTimeoutMs: 10,
      jitterMs: 0,
    });

    poller.start();
    await completion;

    t.assert.deepStrictEqual(abortedServers, ["slow"]);
    await poller.stop().catch(noop);
  });

  it("throws when start is invoked twice", async (t: TestContext) => {
    const app = await build(t);
    const pollerService = app.getDecorator<PollerService>(kPoller);

    const poller = pollerService.create({
      servers: ["s1"],
      fetchOne: async () => "ok",
      onRound: noop,
      intervalMs: 1,
      requestTimeoutMs: 10,
      jitterMs: 0,
    });

    poller.start();
    t.assert.throws(() => poller.start(), /already started/);
    await poller.stop();
  });


  it(
    "integrates with the Undici GET client transport across multiple servers",
    async (t: TestContext) => {
    const app = await build(t);
    const pollerService = app.getDecorator<PollerService>(kPoller);
    const undiciClient = app.getDecorator<UndiciClientService>(kUndiciClient);

    const fastState = { count: 0 };
    const fastServer = trackServer(createServer((req, res) => {
      fastState.count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ server: "fast", round: fastState.count })
      );
    }));

    const failingServer = trackServer(createServer((req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    }));

    let slowAborted = false;
    const slowServer = trackServer(createServer((req) => {
      req.on("close", () => {
        slowAborted = true;
      });
    }));

    const listen = async (srv: ReturnType<typeof createServer>) =>
      new Promise<AddressInfo>((resolve) => {
        srv.listen(0, () => resolve(srv.address() as AddressInfo));
      });

    const [fastAddr, failingAddr, slowAddr] = await Promise.all([
      listen(fastServer),
      listen(failingServer),
      listen(slowServer),
    ]);
    t.after(() => closeServer(fastServer));
    t.after(() => closeServer(failingServer));
    t.after(() => closeServer(slowServer));

    type Response = { server: string; round: number };

    const client = undiciClient.create();
    const observed: Response[][] = [];

    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const poller = pollerService.create({
      servers: [
        `http://127.0.0.1:${fastAddr.port}`,
        `http://127.0.0.1:${failingAddr.port}`,
        `http://127.0.0.1:${slowAddr.port}`,
      ],
      fetchOne: (server, signal) =>
        client.getJson<Response>(server, "/poll", signal),
      onRound: (responses, context) => {
        observed.push(responses);
        if (context.round === 2) {
          queueMicrotask(() => {
            poller.stop().then(() => done?.(), noop);
          });
        }
      },
      intervalMs: 5,
      requestTimeoutMs: 50,
      jitterMs: 0,
    });

    poller.start();
    await completion;

      t.assert.deepStrictEqual(observed, [
        [{ server: "fast", round: 1 }],
        [{ server: "fast", round: 2 }],
      ]);
      t.assert.ok(slowAborted, "expected slow server request to be aborted");
      await client.close();
    }
  );
});
