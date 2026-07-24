import { TokenCounter } from "../llm/token-counter.js";
import type { Message } from "../llm/provider.js";

export interface TokenBudgetConfig {
  maxTokens: number;
  warningRatio?: number;
}

export interface TokenBudgetUsage {
  tokens: number;
  maxTokens: number;
  isNearLimit: boolean;
  isOverBudget: boolean;
}

export class TokenBudget {
  private counter = new TokenCounter();
  private warningRatio: number;

  constructor(private config: TokenBudgetConfig) {
    this.warningRatio = config.warningRatio ?? 0.8;
  }

  measureText(text: string): TokenBudgetUsage {
    return this.toUsage(this.counter.estimate(text));
  }

  measureMessages(messages: Message[]): TokenBudgetUsage {
    return this.toUsage(this.counter.estimateMessages(messages));
  }

  private toUsage(tokens: number): TokenBudgetUsage {
    return {
      tokens,
      maxTokens: this.config.maxTokens,
      isNearLimit: tokens >= this.config.maxTokens * this.warningRatio,
      isOverBudget: tokens > this.config.maxTokens,
    };
  }
}
