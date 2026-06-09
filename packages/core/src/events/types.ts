import type { TokenUsage, Message } from "../llm/provider.js";

export type PipelineEvent =
  | { type: "user-message"; content: string }
  | { type: "llm-token"; text: string; index: number }
  | { type: "llm-thinking"; text: string }
  | { type: "llm-thinking-complete" }
  | { type: "llm-response-complete"; usage: TokenUsage }
  | { type: "stream-complete"; messages: Message[] }
  | { type: "error"; error: Error; context: string };

export type Middleware = (
  event: PipelineEvent,
  next: () => Promise<void>
) => Promise<void>;
