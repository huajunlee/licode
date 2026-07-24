import type { TokenUsage, Message, ToolUseBlock } from "../llm/provider.js";
import type { ToolResult } from "../tools/types.js";
import type { TerminationStats } from "../agent/termination.js";

export type PipelineEvent =
  | { type: "user-message"; content: string }
  | { type: "llm-token"; text: string; index: number }
  | { type: "llm-thinking"; text: string }
  | { type: "llm-thinking-complete" }
  | { type: "llm-response-complete"; usage: TokenUsage }
  | { type: "stream-complete"; messages: Message[] }
  | { type: "error"; error: Error; context: string }
  | {
      type: "context-compressed";
      method: "trim" | "summarize";
      removedMessages?: number;
    }
  // Phase 2 agent events
  | { type: "agent-loop-start" }
  | { type: "agent-loop-step"; index: number; reasoning: string }
  | { type: "tool-use-detected"; toolUses: ToolUseBlock[] }
  | { type: "tool-execute-start"; toolName: string; input: Record<string, unknown> }
  | { type: "tool-execute-complete"; toolName: string; result: ToolResult }
  | { type: "agent-loop-complete"; message: string; usage: TokenUsage }
  | { type: "agent-loop-terminated"; reason: string; stats: TerminationStats };

export type Middleware = (
  event: PipelineEvent,
  next: () => Promise<void>
) => Promise<void>;
