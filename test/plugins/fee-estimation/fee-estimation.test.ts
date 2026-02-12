import { describe, it, type TestContext } from "node:test";
import {
  createFeeEstimationService,
  ESTIMATE_UNAVAILABLE_MESSAGE,
} from "../../../src/plugins/app/fee-estimation/fee-estimation.js";
import type { EstimationInput } from "../../../src/plugins/app/fee-estimation/schemas/estimation.js";
import type { OracleHealthEntry } from "../../../src/plugins/app/oracle-service.js";

function makeSolanaCosts(networkFee: number = 2_190_440) {
  return { estimateUserNetworkFee: async () => networkFee };
}

function makeQubicCosts(networkFee: number = 1) {
  return { estimateUserNetworkFee: async () => networkFee };
}

function makeOracleService(entries: OracleHealthEntry[]) {
  return { list: () => entries };
}

const OUTBOUND_INPUT: EstimationInput = {
  networkIn: 2,
  networkOut: 1,
  fromAddress: "46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV",
  toAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amount: "1000000",
};

const INBOUND_INPUT: EstimationInput = {
  networkIn: 1,
  networkOut: 2,
  fromAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  toAddress: "46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV",
  amount: "1000000",
};

const healthyOracleQubic5 = (url: string): OracleHealthEntry => ({
  url,
  status: "ok",
  timestamp: new Date().toISOString(),
  relayerFeeSolana: 10n,
  relayerFeeQubic: 5n,
});

const healthyOracleSolana20 = (url: string): OracleHealthEntry => ({
  url,
  status: "ok",
  timestamp: new Date().toISOString(),
  relayerFeeSolana: 20n,
  relayerFeeQubic: 1n,
});

describe("fee-estimation", () => {
  it("computes outbound fees (Solana -> Qubic) using median relayer fee", async (t: TestContext) => {
    const oracles = makeOracleService([
      healthyOracleQubic5("http://a"),
      { ...healthyOracleSolana20("http://b"), relayerFeeQubic: 7n },
      { ...healthyOracleQubic5("http://c"), relayerFeeQubic: 3n },
    ]);
    const service = createFeeEstimationService(
      makeSolanaCosts(2_190_440),
      makeQubicCosts(),
      oracles,
    );

    const result = await service.estimate(OUTBOUND_INPUT);

    t.assert.strictEqual(result.bridgeFee.oracleFee, "10000");
    t.assert.strictEqual(result.bridgeFee.protocolFee, "1000");
    t.assert.strictEqual(result.bridgeFee.total, "11000");
    t.assert.strictEqual(result.relayerFee, "5");
    t.assert.strictEqual(result.networkFee, "2190440");
    t.assert.strictEqual(result.userReceives, "988995");
  });

  it("computes inbound fees (Qubic -> Solana) using median relayer fee", async (t: TestContext) => {
    const oracles = makeOracleService([
      healthyOracleQubic5("http://a"),
      healthyOracleSolana20("http://b"),
      { ...healthyOracleQubic5("http://c"), relayerFeeSolana: 15n },
    ]);
    const service = createFeeEstimationService(
      makeSolanaCosts(),
      makeQubicCosts(1),
      oracles,
    );

    const result = await service.estimate(INBOUND_INPUT);

    t.assert.strictEqual(result.bridgeFee.total, "11000");
    t.assert.strictEqual(result.relayerFee, "15");
    t.assert.strictEqual(result.networkFee, "1");
    t.assert.strictEqual(result.userReceives, "988985");
  });

  it("computes median with 4 oracles (even count)", async (t: TestContext) => {
    const oracles = makeOracleService([
      { ...healthyOracleQubic5("http://a"), relayerFeeQubic: 2n },
      { ...healthyOracleSolana20("http://b"), relayerFeeQubic: 4n },
      { ...healthyOracleQubic5("http://c"), relayerFeeQubic: 6n },
      { ...healthyOracleQubic5("http://d"), relayerFeeQubic: 8n },
    ]);
    const service = createFeeEstimationService(
      makeSolanaCosts(2_190_440),
      makeQubicCosts(),
      oracles,
    );

    const result = await service.estimate(OUTBOUND_INPUT);

    t.assert.strictEqual(result.relayerFee, "5");
  });

  it("rejects when fewer than 3 healthy oracles", async (t: TestContext) => {
    const oracles = makeOracleService([
      healthyOracleQubic5("http://a"),
      healthyOracleSolana20("http://b"),
    ]);
    const service = createFeeEstimationService(
      makeSolanaCosts(),
      makeQubicCosts(),
      oracles,
    );

    let err: unknown;
    try {
      await service.estimate(OUTBOUND_INPUT);
    } catch (e) {
      err = e;
    }
    t.assert.ok(err instanceof Error);
    t.assert.strictEqual((err as Error).message, ESTIMATE_UNAVAILABLE_MESSAGE);
    t.assert.strictEqual((err as Error & { statusCode?: number }).statusCode, 503);
  });

  it("rejects when networkIn === networkOut", async (t: TestContext) => {
    const oracles = makeOracleService([
      healthyOracleQubic5("http://a"),
      healthyOracleSolana20("http://b"),
      { ...healthyOracleQubic5("http://c"), relayerFeeQubic: 3n },
    ]);
    const service = createFeeEstimationService(
      makeSolanaCosts(),
      makeQubicCosts(),
      oracles,
    );

    await t.assert.rejects(
      service.estimate({
        ...OUTBOUND_INPUT,
        networkOut: 2,
      }),
      /networkIn and networkOut cannot be the same/,
    );
  });
});
