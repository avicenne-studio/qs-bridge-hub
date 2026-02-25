import { TestContext } from "node:test";

type LoggerMethod = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type LoggerLike = Partial<Record<LoggerMethod, (...args: unknown[]) => unknown>>;

export function mockLogMethod(
  t: TestContext,
  logger: LoggerLike,
  method: LoggerMethod
) {
  return t.mock.method(logger as Record<string, unknown>, method).mock;
}
