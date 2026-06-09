import type { Middleware } from "../types.js";

export function loggingMiddleware(): Middleware {
  return async (event, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] event: ${event.type}`);
    await next();
  };
}
