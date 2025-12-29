import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../helper.js";

test("GET /api/health/bridge reports paused status", async (t) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health/bridge",
    method: "GET",
  });

  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.deepStrictEqual(body, { paused: true });
});

test("GET /api/health/oracles lists oracle statuses", async (t) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health/oracles",
    method: "GET",
  });

  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.oracles));
  assert.ok(body.oracles.length > 0);

  for (const oracle of body.oracles) {
    assert.ok(typeof oracle.url === "string");
    assert.strictEqual(oracle.status, "ok");
    assert.ok(!Number.isNaN(Date.parse(oracle.timestamp)));
  }
});
