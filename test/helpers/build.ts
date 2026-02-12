import fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { TestContext } from "node:test";
import serviceApp from "../../src/app.js";
import fp from "fastify-plugin";
import type { AppConfig } from "../../src/plugins/infra/env.js";
import { kConfig } from "../../src/plugins/infra/env.js";
import { kPoller } from "../../src/plugins/infra/poller.js";
import { kUndiciClient } from "../../src/plugins/infra/undici-client.js";
import { createMockPollerService } from "./infra/poller-mock.js";
import { createMockUndiciClientService } from "./infra/undici-client-mock.js";

// Fill in this config with all the configurations
// needed for testing the application
export function config() {
  return {
    skipOverride: true, // Register our application with fastify-plugin
  };
}

export function expectValidationError(
  t: TestContext,
  res: LightMyRequestResponse,
  expectedMessage: string
) {
  t.assert.strictEqual(res.statusCode, 400);
  const { message } = JSON.parse(res.payload);
  t.assert.strictEqual(message, expectedMessage);
}

type BuildHooks = {
  beforeRegister?: (fastify: FastifyInstance) => void | Promise<void>;
  beforeReady?: (fastify: FastifyInstance) => void | Promise<void>;
};

type BuildOptions = BuildHooks & {
  useMocks?: boolean;
  config?: Partial<AppConfig>;
  decorators?: Record<PropertyKey, unknown>;
  logger?: boolean;
};

const DEFAULT_TEST_CONFIG: AppConfig = {
  PORT: 3000,
  HOST: "127.0.0.1",
  RATE_LIMIT_MAX: 4,
  POLLER_INTERVAL_MS: 50,
  POLLER_REQUEST_TIMEOUT_MS: 200,
  POLLER_JITTER_MS: 0,
  SQLITE_DB_FILE: ":memory:",
  ORACLE_URLS: "http://localhost:3001",
  ORACLE_SIGNATURE_THRESHOLD: 2,
  ORACLE_COUNT: 2,
  HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
  SOLANA_WS_URL: "ws://localhost:8900",
  SOLANA_FALLBACK_WS_URL: "ws://fallback:8900",
  SOLANA_LISTENER_ENABLED: false,
  HELIUS_RPC_URL: "http://localhost:8899",
  HELIUS_POLLER_ENABLED: false,
  HELIUS_POLLER_INTERVAL_MS: 50,
  HELIUS_POLLER_LOOKBACK_SECONDS: 1,
  HELIUS_POLLER_TIMEOUT_MS: 200,
  SOLANA_WS_RECONNECT_BASE_MS: 50,
  SOLANA_WS_RECONNECT_MAX_MS: 200,
  SOLANA_WS_FALLBACK_RETRY_MS: 200,
TOKEN_MINT: "So1111111111111111111111111111111111111111",
};

function resolveBuildOptions(options?: BuildOptions | BuildHooks): BuildOptions {
  return options ?? {};
}

function applyDecorators(
  app: FastifyInstance,
  decorators: Record<PropertyKey, unknown>
) {
  for (const [key, value] of Object.entries(decorators)) {
    if (app.hasDecorator(key)) {
      continue;
    }
    app.decorate(key, value);
  }
  for (const symbol of Object.getOwnPropertySymbols(decorators)) {
    if (app.hasDecorator(symbol)) {
      continue;
    }
    app.decorate(symbol, Reflect.get(decorators, symbol));
  }
}

// automatically build and tear down our instance
export async function build(t?: TestContext, options?: BuildOptions) {
  // you can set all the options supported by the fastify CLI command
  const resolved = resolveBuildOptions(options);
  const app = fastify({ logger: resolved.logger ?? false });

  if (!app.hasDecorator(kConfig)) {
    const testConfig = { ...DEFAULT_TEST_CONFIG, ...(resolved.config ?? {}) };
    app.decorate(kConfig, testConfig);
  }

  if (resolved.useMocks ?? true) {
    if (!app.hasDecorator(kPoller)) {
      app.decorate(kPoller, createMockPollerService());
    }
    if (!app.hasDecorator(kUndiciClient)) {
      app.decorate(kUndiciClient, createMockUndiciClientService());
    }
  }

  if (resolved.decorators) {
    applyDecorators(app, resolved.decorators);
  }

  if (resolved.beforeRegister) {
    await resolved.beforeRegister(app);
  }

  app.register(fp(serviceApp));

  if (resolved.beforeReady) {
    await resolved.beforeReady(app);
  }

  await app.ready();

  // If we pass the test context, it will close the app after we are done
  if (t) {
    t.after(() => app.close());
  }

  return app;
}
