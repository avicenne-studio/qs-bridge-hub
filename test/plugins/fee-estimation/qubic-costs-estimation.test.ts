import { describe, it, type TestContext } from "node:test";
import {
  createQubicCostsEstimation,
  MOCK_USER_NETWORK_FEE_QUBIC,
} from "../../../src/plugins/app/fee-estimation/qubic-costs-estimation.js";

describe("qubic-costs-estimation", () => {
  it("returns mock network fee", async (t: TestContext) => {
    const service = createQubicCostsEstimation();
    const fee = await service.estimateUserNetworkFee();
    t.assert.strictEqual(fee, MOCK_USER_NETWORK_FEE_QUBIC);
  });
});
