import {
  type UndiciClient,
  type UndiciClientOptions,
  type UndiciClientService,
} from "../../../src/plugins/infra/undici-client.js";

class MockUndiciClient implements UndiciClient {
  async getJson<T>(): Promise<T> {
    throw new Error("MockUndiciClient.getJson not implemented");
  }

  async postJson<T>(): Promise<T> {
    throw new Error("MockUndiciClient.postJson not implemented");
  }

  async close(): Promise<void> {
    return;
  }
}

export function createMockUndiciClientService(): UndiciClientService {
  return {
    defaults: Object.freeze({
      connectionsPerOrigin: 1,
      pipelining: 1,
      headers: {},
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
      connectTimeout: 5_000,
    }),
    create(_options?: UndiciClientOptions) {
      void _options;
      return new MockUndiciClient();
    },
  };
}
