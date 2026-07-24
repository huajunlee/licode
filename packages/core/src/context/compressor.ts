import { TokenCounter } from "../llm/token-counter.js";
import type { Message } from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";

export interface ContextCompressorConfig {
  maxTokens: number;
  summarizer: (messages: Message[]) => Promise<string>;
}

export interface CompressionResult {
  compressed: boolean;
  removedMessages: number;
  summary?: string;
}

export class ContextCompressor {
  private counter = new TokenCounter();

  constructor(private config: ContextCompressorConfig) {}

  async compress(conversation: ConversationManager): Promise<CompressionResult> {
    const messages = [...conversation.getMessages()];
    if (this.counter.estimateMessages(messages) <= this.config.maxTokens) {
      return { compressed: false, removedMessages: 0 };
    }

    const keep: Message[] = [];
    let tokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.counter.estimateMessages([messages[i]]);
      if (tokens + msgTokens > this.config.maxTokens / 2 && keep.length > 0) {
        break;
      }
      keep.unshift(messages[i]);
      tokens += msgTokens;
    }

    const removed = messages.slice(0, messages.length - keep.length);
    const summary = await this.config.summarizer(removed);
    const summaryMessage: Message = {
      role: "assistant",
      content: `Previous conversation summary: ${summary}`,
      timestamp: new Date().toISOString(),
    };

    conversation.replaceMessages([summaryMessage, ...keep]);
    return {
      compressed: true,
      removedMessages: removed.length,
      summary,
    };
  }
}
