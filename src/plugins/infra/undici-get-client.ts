import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Dispatcher, Pool, request } from "undici";

export interface UndiciGetClientOptions {
  connectionsPerOrigin?: number;
  pipelining?: number;
  headers?: Record<string, string>;
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  connectTimeout?: number;
}

type ResolvedOptions = Required<
  Omit<UndiciGetClientOptions, "headers">
> & { headers: Record<string, string> };

const DEFAULT_GET_CLIENT_OPTIONS: ResolvedOptions = Object.freeze({
  connectionsPerOrigin: 1,
  pipelining: 1,
  headers: {},
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  connectTimeout: 5_000,
});

export class UndiciGetClient {
  private readonly pools = new Map<string, Pool>();
  private readonly opts: ResolvedOptions;

  constructor(opts: UndiciGetClientOptions = {}) {
    this.opts = {
      connectionsPerOrigin:
        opts.connectionsPerOrigin ?? DEFAULT_GET_CLIENT_OPTIONS.connectionsPerOrigin,
      pipelining: opts.pipelining ?? DEFAULT_GET_CLIENT_OPTIONS.pipelining,
      headers: { ...DEFAULT_GET_CLIENT_OPTIONS.headers, ...(opts.headers ?? {}) },
      keepAliveTimeout:
        opts.keepAliveTimeout ?? DEFAULT_GET_CLIENT_OPTIONS.keepAliveTimeout,
      keepAliveMaxTimeout:
        opts.keepAliveMaxTimeout ?? DEFAULT_GET_CLIENT_OPTIONS.keepAliveMaxTimeout,
      connectTimeout:
        opts.connectTimeout ?? DEFAULT_GET_CLIENT_OPTIONS.connectTimeout,
    };
  }

  private poolFor(origin: string): Dispatcher {
    let pool = this.pools.get(origin);
    if (!pool) {
      pool = new Pool(origin, {
        connections: this.opts.connectionsPerOrigin,
        pipelining: this.opts.pipelining,
        keepAliveTimeout: this.opts.keepAliveTimeout,
        keepAliveMaxTimeout: this.opts.keepAliveMaxTimeout,
        connectTimeout: this.opts.connectTimeout,
      });
      this.pools.set(origin, pool);
    }
    return pool;
  }

  async getJson<T>(
    origin: string,
    path: string,
    signal?: AbortSignal,
    headers?: Record<string, string>
  ): Promise<T> {
    const res = await request(`${origin}${path}`, {
      method: "GET",
      dispatcher: this.poolFor(origin),
      signal,
      headers: { ...this.opts.headers, ...(headers ?? {}) },
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}`);
    }

    return (await res.body.json()) as T;
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.close()));
  }
}

declare module "fastify" {
  interface FastifyInstance {
    undiciGetClient: {
      defaults: Readonly<ResolvedOptions>;
      create(options?: UndiciGetClientOptions): UndiciGetClient;
    };
  }
}

export default fp(
  function undiciGetClientPlugin(fastify: FastifyInstance) {
    const clients = new Set<UndiciGetClient>();

    fastify.decorate("undiciGetClient", {
      defaults: DEFAULT_GET_CLIENT_OPTIONS,
      create(options?: UndiciGetClientOptions) {
        const client = new UndiciGetClient(options);
        clients.add(client);
        return client;
      },
    });

    fastify.addHook("onClose", async () => {
      await Promise.all(
        [...clients].map(async (client) => {
          await client.close();
        })
      );
      clients.clear();
    });
  },
  {
    name: "undici-get-client",
  }
);
