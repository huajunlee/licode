import type { ConversationManager } from "../conversation/manager.js";
import type { Middleware, PipelineEvent } from "../events/types.js";
import type { ContextCompressor } from "./compressor.js";

export function contextMiddleware(
  conversation: ConversationManager,
  compressor: ContextCompressor,
  emit?: (event: PipelineEvent) => void
): Middleware {
  return async (event, next) => {
    if (event.type === "user-message") {
      const result = await compressor.compress(conversation);
      if (result.compressed) {
        emit?.({
          type: "context-compressed",
          method: "summarize",
          removedMessages: result.removedMessages,
        });
      }
    }
    await next();
  };
}
