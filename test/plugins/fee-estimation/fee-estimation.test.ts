import { describe, it, type TestContext } from "node:test";
import {
  createFeeEstimation,
  MOCK_RELAYER_FEE_QUBIC,
  MOCK_RELAYER_FEE_SOLANA,
} from "../../../src/plugins/app/fee-estimation/fee-estimation.js";
import type { EstimationInput } from "../../../src/plugins/app/fee-estimation/schemas/estimation.js";

function makeSolanaCosts(networkFee: number = 2_190_440) {
  return { estimateUserNetworkFee: async () => networkFee };
}

function makeQubicCosts(networkFee: number = 1) {
  return { estimateUserNetworkFee: async () => networkFee };
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

describe("fee-estimation", () => {
  it("computes outbound fees (Solana -> Qubic)", async (t: TestContext) => {
    const service = createFeeEstimation(
      makeSolanaCosts(2_190_440),
      makeQubicCosts(),
    );

    const result = await service.estimate(OUTBOUND_INPUT);

    t.assert.strictEqual(result.bridgeFee.oracleFee, "10000");
    t.assert.strictEqual(result.bridgeFee.protocolFee, "1000");
    t.assert.strictEqual(result.bridgeFee.total, "11000");

    t.assert.strictEqual(result.relayerFee, String(MOCK_RELAYER_FEE_QUBIC));
    t.assert.strictEqual(result.networkFee, "2190440");
    t.assert.strictEqual(result.userReceives, "988999");
  });

  it("computes inbound fees (Qubic -> Solana)", async (t: TestContext) => {
    const service = createFeeEstimation(
      makeSolanaCosts(),
      makeQubicCosts(1),
    );

    const result = await service.estimate(INBOUND_INPUT);

    t.assert.strictEqual(result.bridgeFee.total, "11000");

    t.assert.strictEqual(result.relayerFee, String(MOCK_RELAYER_FEE_SOLANA));
    t.assert.strictEqual(result.networkFee, "1");
    t.assert.strictEqual(result.userReceives, "988999");
  });

  it("rejects when networkIn === networkOut", async (t: TestContext) => {
    const service = createFeeEstimation(
      makeSolanaCosts(),
      makeQubicCosts(),
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
