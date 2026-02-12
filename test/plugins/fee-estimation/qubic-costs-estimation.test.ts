import { describe, it, type TestContext } from "node:test";
import fastify from "fastify";
import qubicCostsEstimationPlugin, {
  kQubicCostsEstimation,
  QubicCostsEstimationService,
} from "../../../src/plugins/app/fee-estimation/qubic-costs-estimation.js";
import { MOCK_USER_NETWORK_FEE_QUBIC } from "../../../src/plugins/app/fee-estimation/common/mocks.js";

async function buildApp(t: TestContext) {
  const app = fastify({ logger: false });
  app.register(qubicCostsEstimationPlugin);
  await app.ready();
  t.after(() => app.close());
  return app;
}

describe("qubic-costs-estimation plugin", () => {
  it("returns mock network fee", async (t: TestContext) => {
    const app = await buildApp(t);
    const service =
      app.getDecorator<QubicCostsEstimationService>(kQubicCostsEstimation);

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
