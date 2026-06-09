import type { Middleware } from "../types.js";

export function tokenCountingMiddleware(
  onUpdate: (total: number) => void
): Middleware {
  let totalTokens = 0;

  return async (event, next) => {
    if (event.type === "llm-response-complete") {
      totalTokens += event.usage.input + event.usage.output;
      onUpdate(totalTokens);
    }
    await next();
  };
}
