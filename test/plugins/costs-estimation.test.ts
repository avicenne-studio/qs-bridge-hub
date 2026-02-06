import { describe, it, type TestContext } from "node:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo } from "node:net";
import fastify from "fastify";
import fp from "fastify-plugin";
import { type Address } from "@solana/kit";
import { kConfig, type AppConfig } from "../../src/plugins/infra/env.js";
import undiciClientPlugin from "../../src/plugins/infra/undici-client.js";
import costsEstimationPlugin, {
  kCostsEstimation,
  CostsEstimationService,
} from "../../src/plugins/app/costs-estimation.js";
import {
  BASE_FEE_LAMPORTS,
  ATA_RENT_LAMPORTS,
  INBOUND_ORDER_RENT_LAMPORTS,
  INBOUND_CU,
} from "../../src/plugins/app/common/solana.js";
import { findAssociatedTokenAddress } from "../../src/plugins/app/common/solana.js";
import {
  getGlobalStateEncoder,
  type GlobalStateArgs,
} from "../../src/clients/js/accounts/globalState.js";
import { Key } from "../../src/clients/js/types/key.js";
import { findGlobalStatePda } from "../../src/clients/js/pdas/globalState.js";

const TEST_TOKEN_MINT =
  "4bbjhGLSYwku6Y44dqwcroRfj2vHCdiHJ9SUmndc4FVg" as Address;
const TEST_ADMIN =
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
const TEST_RECIPIENT =
  "46F9i1Bzv8kwShyG8xbtdkA7nEoYmzyueKwjXyDgtAQV" as Address;

function encodeGlobalState(tokenMint: Address = TEST_TOKEN_MINT): string {
  const state: GlobalStateArgs = {
    key: Key.GlobalState,
    admin: TEST_ADMIN,
    protocolFeeRecipient: TEST_ADMIN,
    tokenMint,
    owedProtocolFee: 0n,
    bpsFee: 100,
    protocolFeeBpsOfBps: 50,
    paused: false,
    oracleCount: 3,
    bump: 255,
  };
  const bytes = getGlobalStateEncoder().encode(state);
  return Buffer.from(bytes).toString("base64");
}

function rpcOk(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function accountInfoResult(base64Data: string | null) {
  return {
    context: { slot: 1 },
    value: base64Data
      ? {
          data: [base64Data, "base64"],
          executable: false,
          lamports: 1_000_000,
          owner: "qSBGtee9tspoDVmb867Wq6tcR3kp19XN1PbBVckrH7H",
          rentEpoch: 0,
        }
      : null,
  };
}

type MethodHandler = (
  params: unknown[],
  id: unknown,
) => string;

async function createRpcServer(
  t: TestContext,
  handlers: Record<string, MethodHandler>,
): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
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
  app.register(costsEstimationPlugin);
  await app.ready();
  t.after(() => app.close());
  return app;
}

describe("costs-estimation plugin", () => {
  it("loads globalState at startup and estimates cost with existing ATA", async (t: TestContext) => {
    const globalStateBase64 = encodeGlobalState();
    const [globalStatePda] = await findGlobalStatePda();
    const recipientAta = await findAssociatedTokenAddress(
      TEST_RECIPIENT,
      TEST_TOKEN_MINT,
    );

    const origin = await createRpcServer(t, {
      getAccountInfo: (params, id) => {
        const address = params[0] as string;
        if (address === globalStatePda) {
          return rpcOk(id, accountInfoResult(globalStateBase64));
        }
        if (address === recipientAta) {
          return rpcOk(id, accountInfoResult("AAAA"));
        }
        return rpcOk(id, accountInfoResult(null));
      },
      getPriorityFeeEstimate: (_params, id) => {
        return rpcOk(id, { priorityFeeEstimate: 50_000 });
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<CostsEstimationService>(kCostsEstimation);

    const totalLamports = await service.estimateInboundCost(TEST_RECIPIENT);
    const secondCall = await service.estimateInboundCost(TEST_RECIPIENT);

    const expectedPriorityFee = Math.ceil(50_000 * INBOUND_CU / 1_000_000);
    t.assert.strictEqual(totalLamports, BASE_FEE_LAMPORTS + expectedPriorityFee + INBOUND_ORDER_RENT_LAMPORTS);
    t.assert.strictEqual(secondCall, totalLamports);
  });

  it("includes ATA rent when recipient has no ATA", async (t: TestContext) => {
    const globalStateBase64 = encodeGlobalState();
    const [globalStatePda] = await findGlobalStatePda();

    const origin = await createRpcServer(t, {
      getAccountInfo: (params, id) => {
        const address = params[0] as string;
        if (address === globalStatePda) {
          return rpcOk(id, accountInfoResult(globalStateBase64));
        }
        return rpcOk(id, accountInfoResult(null));
      },
      getPriorityFeeEstimate: (_params, id) => {
        return rpcOk(id, { priorityFeeEstimate: 50_000 });
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<CostsEstimationService>(kCostsEstimation);

    const totalLamports = await service.estimateInboundCost(TEST_RECIPIENT);

    const expectedPriorityFee = Math.ceil(50_000 * INBOUND_CU / 1_000_000);
    t.assert.strictEqual(totalLamports, BASE_FEE_LAMPORTS + expectedPriorityFee + ATA_RENT_LAMPORTS + INBOUND_ORDER_RENT_LAMPORTS);
  });

  it("rejects when globalState is not found on-chain", async (t: TestContext) => {
    const origin = await createRpcServer(t, {
      getAccountInfo: (_params, id) => {
        return rpcOk(id, accountInfoResult(null));
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<CostsEstimationService>(kCostsEstimation);

    await t.assert.rejects(
      service.estimateInboundCost(TEST_RECIPIENT),
      /globalState account not found/,
    );
  });

  it("sends the correct account keys to getPriorityFeeEstimate", async (t: TestContext) => {
    const globalStateBase64 = encodeGlobalState();
    const [globalStatePda] = await findGlobalStatePda();
    const receivedFeeParams: unknown[] = [];

    const origin = await createRpcServer(t, {
      getAccountInfo: (params, id) => {
        const address = params[0] as string;
        if (address === globalStatePda) {
          return rpcOk(id, accountInfoResult(globalStateBase64));
        }
        return rpcOk(id, accountInfoResult(null));
      },
      getPriorityFeeEstimate: (params, id) => {
        receivedFeeParams.push(params);
        return rpcOk(id, { priorityFeeEstimate: 1_000 });
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<CostsEstimationService>(kCostsEstimation);
    await service.estimateInboundCost(TEST_RECIPIENT);

    t.assert.strictEqual(receivedFeeParams.length, 1);
    const feeReq = (receivedFeeParams[0] as Record<string, unknown>[])[0];
    const keys = feeReq.accountKeys as string[];

    t.assert.ok(keys.includes("qSBGtee9tspoDVmb867Wq6tcR3kp19XN1PbBVckrH7H"));
    t.assert.ok(keys.includes(globalStatePda));
    t.assert.ok(keys.includes(TEST_TOKEN_MINT));
    t.assert.ok(keys.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    t.assert.ok(keys.includes("11111111111111111111111111111111"));
    t.assert.ok(keys.includes("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
    t.assert.strictEqual(keys.length, 6);
  });

  it("rejects when priority fee call fails", async (t: TestContext) => {
    const globalStateBase64 = encodeGlobalState();
    const [globalStatePda] = await findGlobalStatePda();

    const origin = await createRpcServer(t, {
      getAccountInfo: (params, id) => {
        const address = params[0] as string;
        if (address === globalStatePda) {
          return rpcOk(id, accountInfoResult(globalStateBase64));
        }
        return rpcOk(id, accountInfoResult(null));
      },
    });

    const app = await buildApp(t, origin);
    const service = app.getDecorator<CostsEstimationService>(kCostsEstimation);

    await t.assert.rejects(
      service.estimateInboundCost(TEST_RECIPIENT),
      /HTTP 400/,
    );
  });
});
