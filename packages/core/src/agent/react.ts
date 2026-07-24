import type {
  LLMProvider,
  LLMToolDefinition,
  ToolUseBlock,
  TokenUsage,
  Message,
} from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { PipelineEvent } from "../events/types.js";

export type CollectResult =
  | { type: "text"; content: string; usage: TokenUsage }
  | { type: "tool-use"; toolUses: ToolUseBlock[]; usage: TokenUsage };

export interface EventBus {
  emit(event: PipelineEvent): void;
}

export async function collectResponse(
  llm: LLMProvider,
  messages: Message[],
  tools: LLMToolDefinition[],
  conversation: ConversationManager,
  eventBus?: EventBus
): Promise<CollectResult> {
  const textChunks: string[] = [];
  const toolUses: ToolUseBlock[] = [];
  let usage: TokenUsage = { input: 0, output: 0 };
  let tokenIndex = 0;
  let inThinking = false;

  for await (const chunk of llm.stream({
    messages,
    model: conversation.metadata.model,
    tools: tools.length > 0 ? tools : undefined,
    maxTokens: 4096,
  })) {
    switch (chunk.type) {
      case "thinking": {
        if (!inThinking) inThinking = true;
        eventBus?.emit({ type: "llm-thinking", text: chunk.text });
        break;
      }
      case "token": {
        if (inThinking) {
          eventBus?.emit({ type: "llm-thinking-complete" });
          inThinking = false;
        }
        conversation.appendToAssistantMessage(chunk.text);
        eventBus?.emit({
          type: "llm-token",
          text: chunk.text,
          index: tokenIndex,
        });
        textChunks.push(chunk.text);
        tokenIndex++;
        break;
      }
      case "tool-use": {
        if (inThinking) {
          eventBus?.emit({ type: "llm-thinking-complete" });
          inThinking = false;
        }
        toolUses.push(chunk.toolUse);
        break;
      }
      case "stop": {
        if (inThinking) {
          eventBus?.emit({ type: "llm-thinking-complete" });
          inThinking = false;
        }
        usage = chunk.usage;
        break;
      }
      case "error": {
        eventBus?.emit({
          type: "error",
          error: chunk.error,
          context: "llm-stream",
        });
        break;
      }
    }
  }

  if (toolUses.length > 0) {
    return { type: "tool-use", toolUses, usage };
  }

  return { type: "text", content: textChunks.join(""), usage };
}
