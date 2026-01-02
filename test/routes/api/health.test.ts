import { test, TestContext } from "node:test";
import { build } from "../../helpers/build.js";

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
  const expected = app.oracleService.list();

  const res = await app.inject({
    url: "/api/health/oracles",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.deepStrictEqual(body, { oracles: expected });
});
