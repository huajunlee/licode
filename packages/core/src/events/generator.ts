import type { PipelineEvent } from "./types.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";

export async function* generateChatEvents(
  input: string,
  conversationManager: ConversationManager,
  llmProvider: LLMProvider
): AsyncGenerator<PipelineEvent> {
  // MUST add to manager before yielding user-message:
  // the middleware reads messages from the manager immediately on this event.
  conversationManager.addUserMessage(input);

  yield { type: "user-message", content: input };

  const messages = conversationManager.buildMessages();

  try {
    let tokenIndex = 0;
    let hasTokens = false;
    let inThinking = false;
    for await (const chunk of llmProvider.stream({
      messages,
      model: conversationManager.metadata.model,
    })) {
      if (chunk.type === "thinking") {
        yield { type: "llm-thinking", text: chunk.text };
        inThinking = true;
      } else if (chunk.type === "token") {
        if (inThinking) {
          yield { type: "llm-thinking-complete" };
          inThinking = false;
        }
        yield { type: "llm-token", text: chunk.text, index: tokenIndex };
        conversationManager.appendToAssistantMessage(chunk.text);
        tokenIndex++;
        hasTokens = true;
      } else if (chunk.type === "stop") {
        if (inThinking) {
          yield { type: "llm-thinking-complete" };
          inThinking = false;
        }
        // LLM may return stop without producing any token chunks.
        // Ensure an assistant message exists so finalize works.
        if (!hasTokens) {
          conversationManager.appendToAssistantMessage("");
        }
        conversationManager.finalizeAssistantMessage(chunk.usage);
        yield { type: "llm-response-complete", usage: chunk.usage };
      } else if (chunk.type === "error") {
        yield {
          type: "error",
          error: chunk.error,
          context: "llm-stream",
        };
      }
    }

    await conversationManager.save();

    yield {
      type: "stream-complete",
      messages: [...conversationManager.getMessages()],
    };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
      context: "chat-generation",
    };
  }
}
