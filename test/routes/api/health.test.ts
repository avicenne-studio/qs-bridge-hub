import { test, TestContext } from "node:test";
import { build } from "../../helpers/build.js";
import {
  kOracleService,
  type OracleService,
} from "../../../src/plugins/app/oracle-service.js";
import {
  kBridgeState,
  type BridgePauseState,
} from "../../../src/plugins/app/bridge-state.js";

function makeBridgeState(state: BridgePauseState) {
  return { getPauseState: async () => state };
}

test("GET /api/health/bridge returns paused=false when both chains are active", async (t: TestContext) => {
  const app = await build(t, {
    decorators: { [kBridgeState]: makeBridgeState({ solana: false, qubic: false }) },
  });

  const res = await app.inject({ url: "/api/health/bridge", method: "GET" });

  t.assert.strictEqual(res.statusCode, 200);
  t.assert.deepStrictEqual(JSON.parse(res.payload), { paused: false });
});

test("GET /api/health/bridge returns paused=true when solana is paused", async (t: TestContext) => {
  const app = await build(t, {
    decorators: { [kBridgeState]: makeBridgeState({ solana: true, qubic: false }) },
  });

  const res = await app.inject({ url: "/api/health/bridge", method: "GET" });

  t.assert.strictEqual(res.statusCode, 200);
  t.assert.deepStrictEqual(JSON.parse(res.payload), { paused: true });
});

test("GET /api/health/bridge returns paused=true when qubic is paused", async (t: TestContext) => {
  const app = await build(t, {
    decorators: { [kBridgeState]: makeBridgeState({ solana: false, qubic: true }) },
  });

  const res = await app.inject({ url: "/api/health/bridge", method: "GET" });

  t.assert.strictEqual(res.statusCode, 200);
  t.assert.deepStrictEqual(JSON.parse(res.payload), { paused: true });
});

test("GET /api/health/oracles lists oracle statuses", async (t: TestContext) => {
  const app = await build(t);
  const expected = app.getDecorator<OracleService>(kOracleService)
    .list()
    .map((entry) => ({
      ...entry,
      relayerFeeToSolana: entry.relayerFeeToSolana.toString(),
      relayerFeeToQubic: entry.relayerFeeToQubic.toString(),
    }));

  const res = await app.inject({
    url: "/api/health/oracles",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.deepStrictEqual(body, { oracles: expected });
});
