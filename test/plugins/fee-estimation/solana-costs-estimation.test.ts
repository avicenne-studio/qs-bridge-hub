import { describe, it, type TestContext } from "node:test";
import { type AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import {
  createSolanaCostsEstimation,
  BASE_FEE_LAMPORTS,
  OUTBOUND_ORDER_RENT_LAMPORTS,
  OUTBOUND_CU,
  DEFAULT_PRIORITY_FEE_LAMPORTS,
} from "../../../src/plugins/app/fee-estimation/solana-costs-estimation.js";
import { createTrackedServer } from "../../helpers/http-server.js";
import { UndiciClient } from "../../../src/plugins/infra/undici-client.js";
import {
  getGlobalStateEncoder,
} from "../../../src/clients/js/accounts/globalState.js";
import { Key } from "../../../src/clients/js/types/key.js";

type MethodHandler = (params: unknown[], id: unknown) => string;

function rpcOk(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

const TEST_ACCOUNT_KEYS = ["key1", "key2"];
const TEST_GLOBAL_STATE_PDA = "9HzXq7P6UEQjJCrvbPCt4eZRvkoJU9jo1mSssbMHkncQ";

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

function buildService(
  rpcUrl: string,
  accountKeys: string[] = TEST_ACCOUNT_KEYS,
  globalStatePda: string = TEST_GLOBAL_STATE_PDA,
) {
  const httpClient = new UndiciClient();
  return createSolanaCostsEstimation(httpClient, rpcUrl, accountKeys, globalStatePda);
}

function encodeGlobalState(bpsFee: number, protocolFeeBpsOfBps: number): string {
  const ZERO_ADDRESS = "11111111111111111111111111111111" as const;
  const bytes = getGlobalStateEncoder().encode({
    key: Key.GlobalState,
    admin: ZERO_ADDRESS,
    pendingAdmin: null,
    protocolFeeRecipient: ZERO_ADDRESS,
    tokenMint: ZERO_ADDRESS,
    owedProtocolFee: 0n,
    bpsFee,
    protocolFeeBpsOfBps,
    paused: false,
    oracleCount: 0,
    bump: 0,
  });
  return Buffer.from(bytes).toString("base64");
}

describe("solana-costs-estimation", () => {
  it("estimates user network fee from priority fee", async (t: TestContext) => {
    const origin = await createRpcServer(t, {
      getPriorityFeeEstimate: (_params, id) => {
        return rpcOk(id, { priorityFeeEstimate: 50_000 });
      },
    });

    const service = buildService(origin);
    const fee = await service.estimateUserNetworkFee();

    const expectedPriorityFee =
      (BigInt(50_000) * BigInt(OUTBOUND_CU) + 999_999n) / 1_000_000n;
    const expected =
      BigInt(BASE_FEE_LAMPORTS) +
      expectedPriorityFee +
      BigInt(OUTBOUND_ORDER_RENT_LAMPORTS);
    t.assert.strictEqual(fee, expected);
  });

  it("sends the correct account keys to getPriorityFeeEstimate", async (t: TestContext) => {
    const receivedParams: unknown[] = [];
    const customKeys = ["programA", "mintB", "tokenC"];

    const origin = await createRpcServer(t, {
      getPriorityFeeEstimate: (params, id) => {
        receivedParams.push(params);
        return rpcOk(id, { priorityFeeEstimate: 1_000 });
      },
    });

    const service = buildService(origin, customKeys);
    await service.estimateUserNetworkFee();

    t.assert.strictEqual(receivedParams.length, 1);
    const feeReq = (receivedParams[0] as Record<string, unknown>[])[0];
    const keys = feeReq.accountKeys as string[];

    t.assert.deepStrictEqual(keys, customKeys);
  });

  it("falls back to default priority fee when rpc call fails", async (t: TestContext) => {
    const origin = await createRpcServer(t, {});

    const service = buildService(origin);
    const fee = await service.estimateUserNetworkFee();

    const expected =
      BigInt(BASE_FEE_LAMPORTS) +
      DEFAULT_PRIORITY_FEE_LAMPORTS +
      BigInt(OUTBOUND_ORDER_RENT_LAMPORTS);
    t.assert.strictEqual(fee, expected);
  });

  it("fetches bridge fee params from Solana GlobalState", async (t: TestContext) => {
    const origin = await createRpcServer(t, {
      getAccountInfo: (_params, id) => {
        return rpcOk(id, {
          context: { slot: 1 },
          value: {
            data: [encodeGlobalState(250, 500), "base64"],
            executable: false,
            lamports: 2039280,
            owner: "9HzXq7P6UEQjJCrvbPCt4eZRvkoJU9jo1mSssbMHkncQ",
            rentEpoch: 0,
          },
        });
      },
    });

    const service = buildService(origin);
    const params = await service.fetchBridgeFeeParams();

    t.assert.strictEqual(params.bpsFee, 250n);
    t.assert.strictEqual(params.protocolFeeBpsOfBps, 500n);
  });

  it("throws when GlobalState account is missing", async (t: TestContext) => {
    const origin = await createRpcServer(t, {
      getAccountInfo: (_params, id) => {
        return rpcOk(id, { context: { slot: 1 }, value: null });
      },
    });

    const service = buildService(origin);
    await t.assert.rejects(
      service.fetchBridgeFeeParams(),
      /GlobalState account not found/,
    );
  });
});
