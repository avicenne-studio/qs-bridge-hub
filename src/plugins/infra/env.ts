import env from '@fastify/env'
import fp from 'fastify-plugin'

export type AppConfig = {
  PORT: number;
  HOST: string;
  RATE_LIMIT_MAX: number;
  SQLITE_DB_FILE: string;
  ORACLE_URLS: string;
  ORACLE_SIGNATURE_THRESHOLD: number;
  ORACLE_COUNT: number;
  HUB_KEYS_FILE: string;
  SOLANA_WS_URL: string;
  SOLANA_LISTENER_ENABLED: boolean;
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
    'SOLANA_LISTENER_ENABLED'
  ],
  properties: {
    RATE_LIMIT_MAX: {
      type: 'number',
      default: 100 // Put it to 4 in your .env file for tests
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
    SOLANA_LISTENER_ENABLED: {
      type: 'boolean',
      default: true
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
export default fp(env, { name: 'env' })
