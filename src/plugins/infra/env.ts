import env from '@fastify/env'
import fp from 'fastify-plugin'

export type AppConfig = {
  PORT: number;
  HOST: string;
  RATE_LIMIT_MAX: number;
  POLLER_INTERVAL_MS: number;
  POLLER_REQUEST_TIMEOUT_MS: number;
  POLLER_JITTER_MS: number;
  SQLITE_DB_FILE: string;
  ORACLE_URLS: string;
  ORACLE_SIGNATURE_THRESHOLD: number;
  ORACLE_COUNT: number;
  HUB_KEYS_FILE: string;
  SOLANA_WS_URL: string;
  SOLANA_FALLBACK_WS_URL: string;
  SOLANA_LISTENER_ENABLED: boolean;
  HELIUS_RPC_URL: string;
  HELIUS_POLLER_ENABLED: boolean;
  HELIUS_POLLER_INTERVAL_MS: number;
  HELIUS_POLLER_LOOKBACK_SECONDS: number;
  HELIUS_POLLER_TIMEOUT_MS: number;
  HELIUS_POLLER_RETRY_DELAY_MS: number;
  QUBIC_RPC_URL: string;
  QUBIC_POLLER_ENABLED: boolean;
  QUBIC_POLLER_INTERVAL_MS: number;
  QUBIC_POLLER_TIMEOUT_MS: number;
  SOLANA_WS_RECONNECT_BASE_MS: number;
  SOLANA_WS_RECONNECT_MAX_MS: number;
  SOLANA_WS_FALLBACK_RETRY_MS: number;
  TOKEN_MINT: string;
};

export const kConfig = 'config'

const schema = {
  type: 'object',
  required: [
    'SQLITE_DB_FILE',
    'PORT',
    'HOST',
    'ORACLE_URLS',
    'ORACLE_SIGNATURE_THRESHOLD',
    'HUB_KEYS_FILE',
    'ORACLE_COUNT',
    'SOLANA_WS_URL',
    'SOLANA_FALLBACK_WS_URL',
    'SOLANA_LISTENER_ENABLED',
    'HELIUS_RPC_URL',
    'HELIUS_POLLER_ENABLED',
    'HELIUS_POLLER_INTERVAL_MS',
    'HELIUS_POLLER_LOOKBACK_SECONDS',
    'HELIUS_POLLER_TIMEOUT_MS',
    'HELIUS_POLLER_RETRY_DELAY_MS',
    'TOKEN_MINT',
    'QUBIC_RPC_URL',
    'QUBIC_POLLER_ENABLED',
    'QUBIC_POLLER_INTERVAL_MS',
    'QUBIC_POLLER_TIMEOUT_MS'
  ],
  properties: {
    RATE_LIMIT_MAX: {
      type: 'number',
      default: 100 // Put it to 4 in your .env file for tests
    },
    POLLER_INTERVAL_MS: {
      type: 'number',
      minimum: 1000,
      default: 10_000
    },
    POLLER_REQUEST_TIMEOUT_MS: {
      type: 'number',
      minimum: 0,
      default: 700
    },
    POLLER_JITTER_MS: {
      type: 'number',
      minimum: 0,
      default: 25
    },
    SQLITE_DB_FILE: {
      type: 'string',
    },
    PORT: {
      type: 'number',
    },
    HOST: {
      type: 'string',
      default: '0.0.0.0',
      pattern: '^(?:localhost|(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)|(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*|\\[[0-9A-Fa-f:.]+\\])$'
    },
    ORACLE_URLS: {
      type: 'string',
      pattern: '^https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?(,https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?)*$'
    },
    ORACLE_SIGNATURE_THRESHOLD: {
      type: 'number',
      minimum: 0.1,
      default: 0.6
    },
    ORACLE_COUNT: {
      type: 'number',
      minimum: 1,
      default: 6
    },
    HUB_KEYS_FILE: {
      type: 'string',
    },
    SOLANA_WS_URL: {
      type: 'string',
    },
    SOLANA_RPC_URL: {
      type: 'string',
    },
    SOLANA_FALLBACK_WS_URL: {
      type: 'string',
    },
    SOLANA_LISTENER_ENABLED: {
      type: 'boolean',
      default: true
    },
    HELIUS_RPC_URL: {
      type: 'string',
    },
    HELIUS_POLLER_ENABLED: {
      type: 'boolean',
      default: true
    },
    HELIUS_POLLER_INTERVAL_MS: {
      type: 'number',
      minimum: 1000,
      default: 300_000
    },
    HELIUS_POLLER_LOOKBACK_SECONDS: {
      type: 'number',
      minimum: 60,
      default: 600
    },
    HELIUS_POLLER_TIMEOUT_MS: {
      type: 'number',
      minimum: 1000,
      default: 30_000
    },
    HELIUS_POLLER_RETRY_DELAY_MS: {
      type: 'number',
      minimum: 0,
      default: 1000
    },
    QUBIC_RPC_URL: {
      type: 'string',
    },
    QUBIC_POLLER_ENABLED: {
      type: 'boolean',
      default: false
    },
    QUBIC_POLLER_INTERVAL_MS: {
      type: 'number',
      minimum: 1000,
      default: 5_000
    },
    QUBIC_POLLER_TIMEOUT_MS: {
      type: 'number',
      minimum: 1000,
      default: 5_000
    },
    SOLANA_WS_RECONNECT_BASE_MS: {
      type: 'number',
      minimum: 0,
      default: 1000
    },
    SOLANA_WS_RECONNECT_MAX_MS: {
      type: 'number',
      minimum: 0,
      default: 30_000
    },
    SOLANA_WS_FALLBACK_RETRY_MS: {
      type: 'number',
      minimum: 0,
      default: 60_000
    },
    TOKEN_MINT: {
      type: 'string',
    }
  }
}

export const autoConfig = {
  // Decorate Fastify instance with `config` key
  // Optional, default: 'config'
  confKey: 'config',

  // Schema to validate
  schema,

  // Needed to read .env in root folder
  dotenv: true,
  // or, pass config options available on dotenv module
  // dotenv: {
  //   path: `${import.meta.dirname}/.env`,
  //   debug: true
  // }

  // Source for the configuration data
  // Optional, default: process.env
  data: process.env
}

/**
 * This plugins helps to check environment variables.
 *
 * @see {@link https://github.com/fastify/fastify-env}
 */
export default fp(async function envPlugin(fastify, opts) {
  if (fastify.hasDecorator(kConfig)) {
    return;
  }
  await fastify.register(env, opts);
}, { name: 'env' })
