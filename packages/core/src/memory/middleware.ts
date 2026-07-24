import type { Middleware } from "../events/types.js";
import type { MemoryExtractor } from "./extractor.js";
import type { MemoryStore } from "./store.js";

export function memoryMiddleware(
  extractor: MemoryExtractor,
  store: MemoryStore
): Middleware {
  return async (event, next) => {
    if (event.type === "user-message") {
      const entries = extractor.extract(event.content);
      await Promise.all(entries.map((entry) => store.save(entry)));
    }
    await next();
  };
}
