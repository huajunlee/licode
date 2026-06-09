import type { Middleware } from "../types.js";

export function errorHandlerMiddleware(): Middleware {
  return async (event, next) => {
    if (event.type === "error") {
      console.error(`[ERROR] ${event.context}:`, event.error.message);
      return;
    }
    await next();
  };
}
