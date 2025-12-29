import { test, TestContext } from "node:test";
import { build } from "../../helper.js";

test("GET /api/health/bridge reports paused status", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health/bridge",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.deepStrictEqual(body, { paused: true });
});

test("GET /api/health/oracles lists oracle statuses", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health/oracles",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.ok(Array.isArray(body.oracles));
  t.assert.ok(body.oracles.length > 0);

  for (const oracle of body.oracles) {
    t.assert.ok(typeof oracle.url === "string");
    t.assert.strictEqual(oracle.status, "ok");
    t.assert.ok(!Number.isNaN(Date.parse(oracle.timestamp)));
  }
});
