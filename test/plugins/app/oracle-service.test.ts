import { test, TestContext } from "node:test";
import { createServer } from "node:http";
import { build, waitFor } from "../../helper.js";

const ORACLE_URLS = [
  "http://127.0.0.1:6101",
  "http://127.0.0.1:6102",
  "http://127.0.0.1:6103",
];

test("oracle service lists env-configured urls", async (t: TestContext) => {
  const app = await build(t);
  const entries = app.oracleService.list();

  t.assert.deepStrictEqual(
    entries.map((entry) => entry.url),
    ORACLE_URLS
  );
});

test("oracle service updates records", async (t: TestContext) => {
  const app = await build(t);
  const [first] = app.oracleService.list();
  const timestamp = new Date("2024-01-01T00:00:00.000Z").toISOString();

  app.oracleService.update(first.url, {
    status: "ok",
    timestamp,
  });

  const updated = app.oracleService
    .list()
    .find((entry) => entry.url === first.url);

  t.assert.strictEqual(updated?.timestamp, timestamp);
});

test("oracle service polls remote health endpoints", async (t: TestContext) => {
  const [healthyUrl, failingUrl, slowUrl] = ORACLE_URLS;

  let healthyRequests = 0;
  const start = Date.now();

  const healthyServer = createServer((req, res) => {
    if (req.url === "/api/health") {
      healthyRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          timestamp: new Date(start + healthyRequests * 1_000).toISOString(),
        })
      );
      return;
    }
    res.writeHead(404).end();
  });

  const failingServer = createServer((_req, res) => {
    res.writeHead(503).end();
  });

  const slowServer = createServer(() => {
    // intentionally never respond to trigger a timeout
  });

  await new Promise<void>((resolve) => healthyServer.listen(6101, resolve));
  await new Promise<void>((resolve) => failingServer.listen(6102, resolve));
  await new Promise<void>((resolve) => slowServer.listen(6103, resolve));
  t.after(() => healthyServer.close());
  t.after(() => failingServer.close());
  t.after(() => slowServer.close());

  const app = await build(t);

  const initialEntries = new Map(
    app.oracleService.list().map((entry) => [entry.url, entry])
  );

  const getEntry = (url: string) =>
    app.oracleService.list().find((entry) => entry.url === url);

  await waitFor(async () => {
    const healthy = getEntry(healthyUrl);
    const failing = getEntry(failingUrl);
    const slow = getEntry(slowUrl);
    return (
      healthy?.status === "ok" &&
      healthy?.timestamp !== initialEntries.get(healthyUrl)?.timestamp &&
      failing?.status === "down" &&
      slow?.status === "down"
    );
  });

  const firstSnapshot = app.oracleService.list();
  const healthyEntry = firstSnapshot.find((entry) => entry.url === healthyUrl);
  const failingEntry = firstSnapshot.find((entry) => entry.url === failingUrl);
  const slowEntry = firstSnapshot.find((entry) => entry.url === slowUrl);

  t.assert.strictEqual(healthyEntry?.status, "ok");
  t.assert.strictEqual(failingEntry?.status, "down");
  t.assert.strictEqual(slowEntry?.status, "down");

  await waitFor(async () => {
    const next = getEntry(healthyUrl);
    return healthyRequests >= 2 && next !== undefined;
  });

  t.assert.ok(healthyRequests >= 2, "expected at least two polls to occur");
});
