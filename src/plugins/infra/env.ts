import env from '@fastify/env'
import fp from 'fastify-plugin'

declare module 'fastify' {
  export interface FastifyInstance {
    config: {
      PORT: number;
      RATE_LIMIT_MAX: number;
      SQLITE_DB_FILE: string;
      ORACLE_URLS: string;
      HUB_KEYS_FILE: string;
    };
  }
}

const schema = {
  type: 'object',
  required: [
    'SQLITE_DB_FILE',
    'PORT',
    'ORACLE_URLS',
    'HUB_KEYS_FILE'
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
    ORACLE_URLS: {
      type: 'string',
      pattern: '^https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?(,https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?)*$'
    },
    HUB_KEYS_FILE: {
      type: 'string',
    },
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
