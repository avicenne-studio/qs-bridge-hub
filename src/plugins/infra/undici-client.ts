import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Dispatcher, Pool, request } from "undici";

export interface UndiciClientOptions {
  connectionsPerOrigin?: number;
  pipelining?: number;
  headers?: Record<string, string>;
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  connectTimeout?: number;
}

type ResolvedOptions = Required<
  Omit<UndiciClientOptions, "headers">
> & { headers: Record<string, string> };

const DEFAULT_CLIENT_OPTIONS: ResolvedOptions = Object.freeze({
  connectionsPerOrigin: 1,
  pipelining: 1,
  headers: {},
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  connectTimeout: 5_000,
});

export class UndiciClient {
  private readonly pools = new Map<string, Pool>();
  private readonly opts: ResolvedOptions;

  constructor(opts: UndiciClientOptions = {}) {
    this.opts = {
      connectionsPerOrigin:
        opts.connectionsPerOrigin ?? DEFAULT_CLIENT_OPTIONS.connectionsPerOrigin,
      pipelining: opts.pipelining ?? DEFAULT_CLIENT_OPTIONS.pipelining,
      headers: { ...DEFAULT_CLIENT_OPTIONS.headers, ...(opts.headers ?? {}) },
      keepAliveTimeout:
        opts.keepAliveTimeout ?? DEFAULT_CLIENT_OPTIONS.keepAliveTimeout,
      keepAliveMaxTimeout:
        opts.keepAliveMaxTimeout ?? DEFAULT_CLIENT_OPTIONS.keepAliveMaxTimeout,
      connectTimeout:
        opts.connectTimeout ?? DEFAULT_CLIENT_OPTIONS.connectTimeout,
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
    const url = `${origin}${path}`;
    const res = await request(url, {
      method: "GET",
      dispatcher: this.poolFor(origin),
      signal,
      headers: { ...this.opts.headers, ...(headers ?? {}) },
    });

    const payload = await parseBody(res);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new HttpError({
        message: `HTTP ${res.statusCode}`,
        statusCode: res.statusCode,
        url,
        method: "GET",
        body: payload,
      });
    }

    return payload as T;
  }

  async postJson<T>(
    origin: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>
  ): Promise<T> {
    const url = `${origin}${path}`;
    const res = await request(url, {
      method: "POST",
      dispatcher: this.poolFor(origin),
      signal,
      headers: {
        "content-type": "application/json",
        ...this.opts.headers,
        ...(headers ?? {}),
      },
      body: JSON.stringify(body),
    });

    const payload = await parseBody(res);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new HttpError({
        message: `HTTP ${res.statusCode}`,
        statusCode: res.statusCode,
        url,
        method: "POST",
        body: payload,
      });
    }

    return payload as T;
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.close()));
  }
}

export type UndiciClientService = {
  defaults: Readonly<ResolvedOptions>;
  create(options?: UndiciClientOptions): UndiciClient;
};

export const kUndiciClient = Symbol("infra.undiciClient");

export class HttpError extends Error {
  readonly statusCode: number;
  readonly url: string;
  readonly method: string;
  readonly body: unknown;

  constructor(opts: {
    message: string;
    statusCode: number;
    url: string;
    method: string;
    body: unknown;
  }) {
    super(opts.message);
    this.name = "HttpError";
    this.statusCode = opts.statusCode;
    this.url = opts.url;
    this.method = opts.method;
    this.body = opts.body;
  }
}

async function parseBody(res: Awaited<ReturnType<typeof request>>) {
  const contentType = res.headers["content-type"] ?? "";
  const isJson =
    typeof contentType === "string" && contentType.includes("json");
  const text = await res.body.text();
  if (!text) {
    return null;
  }
  if (!isJson) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default fp(
  function undiciClientPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kUndiciClient)) {
      return;
    }
    const clients = new Set<UndiciClient>();

    fastify.decorate(kUndiciClient, {
      defaults: DEFAULT_CLIENT_OPTIONS,
      create(options?: UndiciClientOptions) {
        const client = new UndiciClient(options);
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
    name: "undici-client",
  }
);
