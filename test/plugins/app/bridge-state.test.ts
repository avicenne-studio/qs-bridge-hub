import { describe, it, type TestContext } from "node:test";
import { type AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import {
  createBridgeState,
  BRIDGE_STATE_CACHE_TTL_MS,
} from "../../../src/plugins/app/bridge-state.js";
import { createTrackedServer } from "../../helpers/http-server.js";
import { UndiciClient } from "../../../src/plugins/infra/undici-client.js";
import {
  type QubicContractClient,
  FUNC_GET_CONFIG,
} from "../../../src/plugins/infra/qubic-contract-client.js";
import {
  getGlobalStateEncoder,
} from "../../../src/clients/js/accounts/globalState.js";
import { Key } from "../../../src/clients/js/types/key.js";
import { Address } from "@solana/kit";

const TEST_GLOBAL_STATE_PDA = "9HzXq7P6UEQjJCrvbPCt4eZRvkoJU9jo1mSssbMHkncQ";
const ZERO_ADDRESS = "11111111111111111111111111111111" as Address;

type MethodHandler = (params: unknown[], id: unknown) => string;

function rpcOk(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

async function createRpcServer(
  t: TestContext,
  handlers: Record<string, MethodHandler>,
): Promise<{ url: string; callCount: Record<string, number> }> {
  const callCount: Record<string, number> = {};
  const tracked = createTrackedServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    callCount[body.method] = (callCount[body.method] ?? 0) + 1;

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
  return { url: `http://127.0.0.1:${port}`, callCount };
}

function encodeGlobalState(paused: boolean): string {
  const bytes = getGlobalStateEncoder().encode({
    key: Key.GlobalState,
    admin: ZERO_ADDRESS,
    pendingAdmin: null,
    protocolFeeRecipient: ZERO_ADDRESS,
    tokenMint: ZERO_ADDRESS,
    owedProtocolFee: 0n,
    bpsFee: 100,
    protocolFeeBpsOfBps: 1000,
    paused,
    oracleCount: 0,
    bump: 0,
  });
  return Buffer.from(bytes).toString("base64");
}

// GetConfig_output layout (see qubic-contract-client.ts):
// [0..31]   admin (32 bytes)
// [32..63]  protocolFeeRecipient (32 bytes)
// [64..95]  oracleFeeRecipient (32 bytes)
// [96..99]  bpsFee (uint32 LE)
// [100..103] protocolFee (uint32 LE)
// [104..107] oracleCount (uint32 LE)
// [108..111] pauserCount (uint32 LE)
// [112]     oracleThreshold (uint8)
// [113]     paused (uint8)
// [114..115] padding
// [116..119] orderEra (uint32 LE)
function encodeGetConfig(paused: boolean): string {
  const buf = Buffer.alloc(120);
  buf.writeUInt8(paused ? 1 : 0, 113);
  return buf.toString("hex");
}

function makeQubicClient(paused = false): QubicContractClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    queryContractFunction: async (funcNumber: number, _inputHex: string) => {
      if (funcNumber !== FUNC_GET_CONFIG) {
        throw new Error(`unexpected funcNumber: ${funcNumber}`);
      }
      return encodeGetConfig(paused);
    },
  } as unknown as QubicContractClient;
}

function buildService(
  rpcUrl: string,
  qubicClient: QubicContractClient = makeQubicClient(),
  globalStatePda = TEST_GLOBAL_STATE_PDA,
  cacheTtlMs = BRIDGE_STATE_CACHE_TTL_MS,
) {
  return createBridgeState(
    new UndiciClient(),
    rpcUrl,
    globalStatePda,
    qubicClient,
    cacheTtlMs,
  );
}

function makeAccountInfoResponse(id: unknown, paused: boolean) {
  return rpcOk(id, {
    context: { slot: 1 },
    value: {
      data: [encodeGlobalState(paused), "base64"],
      executable: false,
      lamports: 2039280,
      owner: "9HzXq7P6UEQjJCrvbPCt4eZRvkoJU9jo1mSssbMHkncQ",
      rentEpoch: 0,
    },
  });
}

describe("bridge-state", () => {
  it("returns pause state from both chains when neither is paused", async (t: TestContext) => {
    const { url } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, false),
    });

    const service = buildService(url);
    const state = await service.getPauseState();

    t.assert.strictEqual(state.solana, false);
    t.assert.strictEqual(state.qubic, false);
  });

  it("reflects solana paused=true", async (t: TestContext) => {
    const { url } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, true),
    });

    const service = buildService(url, makeQubicClient(false));
    const state = await service.getPauseState();

    t.assert.strictEqual(state.solana, true);
    t.assert.strictEqual(state.qubic, false);
  });

  it("reflects qubic paused=true", async (t: TestContext) => {
    const { url } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, false),
    });

    const service = buildService(url, makeQubicClient(true));
    const state = await service.getPauseState();

    t.assert.strictEqual(state.solana, false);
    t.assert.strictEqual(state.qubic, true);
  });

  it("returns solana fee params from GlobalState", async (t: TestContext) => {
    const { url } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, false),
    });

    const service = buildService(url);
    const params = await service.getSolanaFeeParams();

    t.assert.strictEqual(params.bpsFee, 100n);
    t.assert.strictEqual(params.protocolFeeBpsOfBps, 1000n);
  });

  it("caches Solana state — getPauseState then getSolanaFeeParams makes one RPC call", async (t: TestContext) => {
    const { url, callCount } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, false),
    });

    const service = buildService(url);
    await service.getPauseState();
    await service.getSolanaFeeParams();

    t.assert.strictEqual(callCount["getAccountInfo"], 1);
  });

  it("caches Solana state within TTL — repeated getPauseState makes one RPC call", async (t: TestContext) => {
    const { url, callCount } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, false),
    });

    const service = buildService(url);
    await service.getPauseState();
    await service.getPauseState();

    t.assert.strictEqual(callCount["getAccountInfo"], 1);
  });

  it("re-fetches Solana state after TTL expires", async (t: TestContext) => {
    const { url, callCount } = await createRpcServer(t, {
      getAccountInfo: (_params, id) => makeAccountInfoResponse(id, false),
    });

    const service = buildService(url, makeQubicClient(), TEST_GLOBAL_STATE_PDA, 0);
    await service.getPauseState();
    await service.getPauseState();

    t.assert.strictEqual(callCount["getAccountInfo"], 2);
  });

  it("throws when Solana GlobalState account not found", async (t: TestContext) => {
    const { url } = await createRpcServer(t, {
      getAccountInfo: (_params, id) =>
        rpcOk(id, { context: { slot: 1 }, value: null }),
    });

    const service = buildService(url);
    await t.assert.rejects(
      service.getPauseState(),
      /GlobalState account not found/,
    );
  });
});
