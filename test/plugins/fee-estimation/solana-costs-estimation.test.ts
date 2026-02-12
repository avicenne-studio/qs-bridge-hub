import { describe, it, type TestContext } from "node:test";
import { type AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { UndiciClient } from "../../../src/plugins/infra/undici-client.js";
import {
  createSolanaCostsEstimation,
  BASE_FEE_LAMPORTS,
  OUTBOUND_ORDER_RENT_LAMPORTS,
  OUTBOUND_CU,
} from "../../../src/plugins/app/fee-estimation/solana-costs-estimation.js";
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

const TEST_ACCOUNT_KEYS = ["program", "mint", "token", "ata", "system"];

function buildService(t: TestContext, rpcUrl: string, accountKeys?: string[]) {
  const httpClient = new UndiciClient();
  t.after(() => httpClient.close());
  return createSolanaCostsEstimation(
    httpClient,
    rpcUrl,
    accountKeys ?? TEST_ACCOUNT_KEYS,
  );
}

describe("solana-costs-estimation", () => {
  it("estimates user network fee from priority fee", async (t: TestContext) => {
    const rpcUrl = await createRpcServer(t, {
      getPriorityFeeEstimate: (_params, id) => {
        return rpcOk(id, { priorityFeeEstimate: 50_000 });
      },
    });

    const service = buildService(t, rpcUrl);
    const fee = await service.estimateUserNetworkFee();

    const expectedPriorityFee = Math.ceil((50_000 * OUTBOUND_CU) / 1_000_000);
    t.assert.strictEqual(
      fee,
      BASE_FEE_LAMPORTS + expectedPriorityFee + OUTBOUND_ORDER_RENT_LAMPORTS,
    );
  });

  it("sends the configured account keys to getPriorityFeeEstimate", async (t: TestContext) => {
    const receivedParams: unknown[] = [];
    const customKeys = ["keyA", "keyB", "keyC"];

    const rpcUrl = await createRpcServer(t, {
      getPriorityFeeEstimate: (params, id) => {
        receivedParams.push(params);
        return rpcOk(id, { priorityFeeEstimate: 1_000 });
      },
    });

    const service = buildService(t, rpcUrl, customKeys);
    await service.estimateUserNetworkFee();

    t.assert.strictEqual(receivedParams.length, 1);
    const feeReq = (receivedParams[0] as Record<string, unknown>[])[0];
    const keys = feeReq.accountKeys as string[];

    t.assert.deepStrictEqual(keys, customKeys);
  });

  it("rejects when priority fee call fails", async (t: TestContext) => {
    const rpcUrl = await createRpcServer(t, {});
    const service = buildService(t, rpcUrl);

    await t.assert.rejects(service.estimateUserNetworkFee(), /HTTP 400/);
  });
});
