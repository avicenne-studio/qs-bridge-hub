import {
  type CreatePollerConfig,
  type PollerHandle,
  type PollerOptions,
  type PollerService,
} from "../../../src/plugins/infra/poller.js";

export function createMockPollerService(
  defaults: PollerOptions = { intervalMs: 10_000, requestTimeoutMs: 700, jitterMs: 0 }
): PollerService {
  return {
    defaults: Object.freeze({ ...defaults }),
    create<TResponse>(_config: CreatePollerConfig<TResponse>): PollerHandle {
      void _config;
      let running = false;
      return {
        start() {
          running = true;
        },
        async stop() {
          running = false;
        },
        isRunning() {
          return running;
        },
      };
    },
  };
}
