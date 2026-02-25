import { HttpError } from "../infra/undici-client.js";

export type ErrorPayload =
  | {
      name: string;
      message: string;
      stack?: string;
      statusCode?: number;
      method?: string;
      url?: string;
      body?: unknown;
    }
  | { value: unknown };

export function formatErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof HttpError) {
    return {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      method: error.method,
      url: error.url,
      body: error.body,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: error };
}
