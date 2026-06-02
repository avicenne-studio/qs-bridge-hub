import { describe, it, type TestContext } from "node:test";
import { createQubicCostsEstimation } from "../../../src/plugins/app/fee-estimation/qubic-costs-estimation.js";

describe("qubic-costs-estimation", () => {
  it("returns configured invocation reward as network fee", async (t: TestContext) => {
    const service = createQubicCostsEstimation(1000);
    const fee = await service.estimateUserNetworkFee();
    t.assert.strictEqual(fee, 1000n);
  });

  it("returns different values for different reward configs", async (t: TestContext) => {
    t.assert.strictEqual(
      await createQubicCostsEstimation(500).estimateUserNetworkFee(),
      500n,
    );
    t.assert.strictEqual(
      await createQubicCostsEstimation(2000).estimateUserNetworkFee(),
      2000n,
    );
  });
});
