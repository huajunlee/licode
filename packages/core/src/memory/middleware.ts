import type { Middleware } from "../events/types.js";
import type { RegexMemoryExtractor } from "./extractor-regex.js";
import type { MemoryStore } from "./store.js";

/**
 * @deprecated Since Step 2, memory extraction uses LLM via
 * {@link createMemoryExtractionHook} registered as an in-process function hook
 * at the `after:agentLoop` position.
 *
 * Kept for backward compatibility — still functional with {@link RegexMemoryExtractor}.
 */
export function memoryMiddleware(
  extractor: RegexMemoryExtractor,
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
