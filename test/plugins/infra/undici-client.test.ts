import { describe, it, TestContext } from "node:test";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { build } from "../../helpers/build.js";
import { createTrackedServer } from "../../helpers/http-server.js";
import {
  UndiciClient,
  kUndiciClient,
  HttpError,
  type UndiciClientService,
} from "../../../src/plugins/infra/undici-client.js";

describe("undici client plugin", () => {
  it("performs GET requests with merged headers and JSON parsing", async (t: TestContext) => {
    const app = await build(t, { useMocks: false });
    const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createTrackedServer((req, res) => {
      receivedHeaders.push(req.headers);
      if (req.url === "/poll") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/text") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("plain-ok");
        return;
      }
      if (req.url === "/bad-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not-json");
        return;
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    await new Promise<void>((resolve) => {
      server.server.listen(0, resolve);
    });
    t.after(() => server.close());

    const { port } = server.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const undiciClient = app.getDecorator<UndiciClientService>(kUndiciClient);
    const client = undiciClient.create({ headers: { "x-default": "base" } });

    const data = await client.getJson<{ ok: boolean }>(
      origin,
      "/poll",
      undefined,
      { "x-extra": "1", "x-default": "override" }
    );

    t.assert.deepStrictEqual(data, { ok: true });
    t.assert.strictEqual(receivedHeaders[0]["x-extra"], "1");
    t.assert.strictEqual(receivedHeaders[0]["x-default"], "override");

    const textPayload = await client.getJson<string>(origin, "/text");
    t.assert.strictEqual(textPayload, "plain-ok");

    const badJsonPayload = await client.getJson<string>(origin, "/bad-json");
    t.assert.strictEqual(badJsonPayload, "not-json");

    await t.assert.rejects(client.getJson(origin, "/fail"), /HTTP 503/);
    await t.assert.rejects(client.postJson(origin, "/fail", {}), /HTTP 503/);
    await t.assert.rejects(
      client.postJson(origin, "/fail", {}),
      (err: unknown) => {
        t.assert.ok(err instanceof HttpError);
        const httpErr = err as HttpError;
        t.assert.strictEqual(httpErr.statusCode, 503);
        t.assert.strictEqual(httpErr.method, "POST");
        t.assert.ok(httpErr.url.includes(origin));
        t.assert.deepStrictEqual(httpErr.body, { error: "boom" });
        return true;
      }
    );
    await client.close();
  });

  it("retries once on UND_ERR_SOCKET (server closes keep-alive connection)", async (t) => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts++;
      if (attempts === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ retried: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    t.after(() => server.close());

    const { port } = server.address() as AddressInfo;
    const client = new UndiciClient();
    t.after(() => client.close());

    const result = await client.getJson<{ retried: boolean }>(`http://127.0.0.1:${port}`, "/test");
    t.assert.deepStrictEqual(result, { retried: true });
    t.assert.strictEqual(attempts, 2);
  });

  it("re-throws non-socket errors without retrying", async (t) => {
    let attempts = 0;
    const server = http.createServer((_req, res) => {
      attempts++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    t.after(() => server.close());

    const { port } = server.address() as AddressInfo;
    const client = new UndiciClient();
    t.after(() => client.close());

    await t.assert.rejects(
      client.getJson(`http://127.0.0.1:${port}`, "/test"),
      (err: unknown) => err instanceof HttpError,
    );
    t.assert.strictEqual(attempts, 1);
  });

  it("closes created clients on app shutdown and exposes defaults", async (t: TestContext) => {
    const app = await build(undefined, { useMocks: false });
    const undiciClient = app.getDecorator<UndiciClientService>(kUndiciClient);

    t.assert.deepStrictEqual(undiciClient.defaults, {
      connectionsPerOrigin: 1,
      pipelining: 1,
      headers: {},
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
      connectTimeout: 5_000,
    });

    const client = undiciClient.create();
    let closed = false;
    const originalClose = client.close.bind(client);
    client.close = async () => {
      closed = true;
      await originalClose();
    };

    await app.close();
    t.assert.ok(closed, "client.close should be invoked on shutdown");
  });
});
