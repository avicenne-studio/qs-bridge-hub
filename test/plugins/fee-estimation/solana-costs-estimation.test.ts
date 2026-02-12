import { describe, it, type TestContext } from "node:test";
import { type AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import fastify from "fastify";
import fp from "fastify-plugin";
import { kConfig, type AppConfig } from "../../../src/plugins/infra/env.js";
import undiciClientPlugin from "../../../src/plugins/infra/undici-client.js";
import solanaCostsEstimationPlugin, {
  kSolanaCostsEstimation,
  SolanaCostsEstimationService,
} from "../../../src/plugins/app/fee-estimation/solana-costs-estimation.js";
import {
  BASE_FEE_LAMPORTS,
  OUTBOUND_ORDER_RENT_LAMPORTS,
  OUTBOUND_CU,
} from "../../../src/plugins/app/fee-estimation/common/solana.js";
import { createTrackedServer } from "../../helpers/http-server.js";

type MethodHandler = (params: unknown[], id: unknown) => string;

function rpcOk(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

async function createRpcServer(
  t: TestContext,
  handlers: Record<string, MethodHandler>,
): Promise<string> {
  const tracked = createTrackedServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    const handler = handlers[body.method];
    if (!handler) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unknown method: ${body.method}` }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(handler(body.params, body.id));
  });

  await new Promise<void>((resolve) => tracked.server.listen(0, resolve));
  t.after(() => tracked.close());
  const { port } = tracked.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function buildApp(t: TestContext, rpcUrl: string) {
  const app = fastify({ logger: false });
  app.register(
    fp(
      async (instance) => {
        instance.decorate(kConfig, {
          HELIUS_RPC_URL: rpcUrl,
        } as AppConfig);
      },
      { name: "env" },
    ),
  );
  app.register(undiciClientPlugin);
  app.register(solanaCostsEstimationPlugin);
  await app.ready();
  t.after(() => app.close());
  return app;
}

describe("solana-costs-estimation plugin", () => {
  it("estimates user network fee from priority fee", async (t: TestContext) => {
    const origin = await createRpcServer(t, {
      getPriorityFeeEstimate: (_params, id) => {
        return rpcOk(id, { priorityFeeEstimate: 50_000 });
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<SolanaCostsEstimationService>(
      kSolanaCostsEstimation,
    );

    const fee = await service.estimateUserNetworkFee();

    const expectedPriorityFee = Math.ceil((50_000 * OUTBOUND_CU) / 1_000_000);
    t.assert.strictEqual(
      fee,
      BASE_FEE_LAMPORTS + expectedPriorityFee + OUTBOUND_ORDER_RENT_LAMPORTS,
    );
  });

  it("sends the correct account keys to getPriorityFeeEstimate", async (t: TestContext) => {
    const receivedParams: unknown[] = [];

    const origin = await createRpcServer(t, {
      getPriorityFeeEstimate: (params, id) => {
        receivedParams.push(params);
        return rpcOk(id, { priorityFeeEstimate: 1_000 });
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<SolanaCostsEstimationService>(
      kSolanaCostsEstimation,
    );
    await service.estimateUserNetworkFee();

    t.assert.strictEqual(receivedParams.length, 1);
    const feeReq = (receivedParams[0] as Record<string, unknown>[])[0];
    const keys = feeReq.accountKeys as string[];

    t.assert.ok(keys.includes("qSBGtee9tspoDVmb867Wq6tcR3kp19XN1PbBVckrH7H"));
    t.assert.ok(keys.includes("4bbjhGLSYwku6Y44dqwcroRfj2vHCdiHJ9SUmndc4FVg"));
    t.assert.ok(keys.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    t.assert.ok(keys.includes("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
    t.assert.ok(keys.includes("11111111111111111111111111111111"));
    t.assert.strictEqual(keys.length, 5);
  });

  it("rejects when priority fee call fails", async (t: TestContext) => {
    const origin = await createRpcServer(t, {});

    const app = await buildApp(t, origin);
    const service = app.getDecorator<SolanaCostsEstimationService>(
      kSolanaCostsEstimation,
    );

    await t.assert.rejects(service.estimateUserNetworkFee(), /HTTP 400/);
  });
});
