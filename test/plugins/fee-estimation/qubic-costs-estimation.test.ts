import { describe, it, type TestContext } from "node:test";
import {
  createQubicCostsEstimation,
  MOCK_USER_NETWORK_FEE_QUBIC,
} from "../../../src/plugins/app/fee-estimation/qubic-costs-estimation.js";

describe("qubic-costs-estimation", () => {
  it("returns mock network fee", async (t: TestContext) => {
    const service = createQubicCostsEstimation();

    const fee = await service.estimateUserNetworkFee({
      networkIn: 1,
      networkOut: 2,
      fromAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      toAddress: "46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV",
      amount: "1000000",
    });

    t.assert.strictEqual(fee, MOCK_USER_NETWORK_FEE_QUBIC);
  });
});
