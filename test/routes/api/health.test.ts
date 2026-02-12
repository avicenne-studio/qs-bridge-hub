import { test, TestContext } from "node:test";
import { build } from "../../helpers/build.js";
import {
  kOracleService,
  type OracleService,
} from "../../../src/plugins/app/oracle-service.js";

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
  const expected = app.getDecorator<OracleService>(kOracleService)
    .list()
    .map((entry) => ({
      ...entry,
      relayerFeeSolana: entry.relayerFeeSolana.toString(),
      relayerFeeQubic: entry.relayerFeeQubic.toString(),
    }));

  const res = await app.inject({
    url: "/api/health/oracles",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.deepStrictEqual(body, { oracles: expected });
});
