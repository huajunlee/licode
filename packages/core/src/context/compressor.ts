import type { Message, UserMessage, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import { isFileChangeMessage, WRITE_TOOL_NAMES, EDIT_TOOL_NAMES } from "./file-change.js";

export interface ContextCompressorConfig {
  /** Produces a summary string from a slice of messages. Throws on failure. */
  summarizer: (messages: Message[]) => Promise<string>;
}

export interface CompressionResult {
  compressed: boolean;
  removedMessages: number;
  summary?: string;
  method?: "summarize" | "trim";
}

/** A real user text message (not a tool_result, which is also role: "user"). */
function isUserTextMessage(m: Message): m is UserMessage {
  return m.role === "user" && typeof m.content === "string";
}

/**
 * Split a message history into turns. A new turn begins at each UserMessage
 * (role "user" with string content). ToolUseMessage/ToolResultMessage pairs
 * and memory-recall synthetic pairs always stay within the turn they belong
 * to - turns are never split mid-pair, so no tool_result is ever orphaned.
 */
export function splitIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const m of messages) {
    if (isUserTextMessage(m) && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/**
 * Structure-aware context compressor (Phase 2). Replaces the dormant
 * index-slicing compressor that could orphan tool_result messages.
 *
 * Compression shape:
 *   [firstUser, SUMMARY(assistant), ...recentTurns]
 * - The first UserMessage (task intent) is always preserved.
 * - The last `keepRecentTurns` turns are kept intact (tool pairs atomic).
 * - Everything between is summarized into one assistant SUMMARY message,
 *   placed right after the first user so role alternation holds (the recent
 *   window starts at a user message).
 * - If the summarizer throws, degrade to trim: drop the middle (folding the
 *   first-user intent into the recent window's first user message to keep
 *   alternation valid) - best-effort, never breaks the loop.
 */
export class ContextCompressor {
  constructor(private config: ContextCompressorConfig) {}

  async compress(
    conversation: ConversationManager,
    opts: { keepRecentTurns: number }
  ): Promise<CompressionResult> {
    const messages = [...conversation.getMessages()];
    if (messages.length === 0) {
      return { compressed: false, removedMessages: 0 };
    }
    // The first message must be the task-intent user message we preserve.
    if (!isUserTextMessage(messages[0])) {
      return { compressed: false, removedMessages: 0 };
    }

    const firstUser = messages[0];
    const turns = splitIntoTurns(messages);
    const K = opts.keepRecentTurns;

    // Need more than K turns so that first-user + last K turns leaves an
    // older region to summarize.
    if (turns.length <= K) {
      return { compressed: false, removedMessages: 0 };
    }

    const recentTurns = turns.slice(turns.length - K);
    const recentStart = messages.indexOf(recentTurns[0][0]);
    const summarizeRegion = messages.slice(1, recentStart);
    if (summarizeRegion.length === 0) {
      return { compressed: false, removedMessages: 0 };
    }

    let method: "summarize" | "trim";
    let summaryText = "";
    try {
      summaryText = await this.config.summarizer(summarizeRegion);
      method = "summarize";
    } catch {
      // Degrade to trim: drop the region with no summary.
      method = "trim";
    }

    const recentFlat: Message[] = recentTurns.flat();
    let kept: Message[];

    if (method === "summarize") {
      const summaryMessage: Message = {
        role: "assistant",
        content: `Previous conversation summary: ${summaryText}`,
        timestamp: new Date().toISOString(),
      };
      // firstUser(user) -> SUMMARY(assistant) -> recentFlat[0](user): alternates.
      kept = [firstUser, summaryMessage, ...recentFlat];
    } else {
      // trim: no summary to bridge firstUser(user) -> recentFlat[0](user).
      // Fold the task intent into the recent window's first user message so
      // the result still starts with a single user message (valid alternation).
      kept = [...recentFlat];
      if (isUserTextMessage(kept[0])) {
        kept[0] = {
          ...kept[0],
          content: `[Earlier task: ${firstUser.content}]\n\n${kept[0].content}`,
        };
      }
    }

    conversation.replaceMessages(kept);
    return {
      compressed: true,
      removedMessages: summarizeRegion.length,
      summary: method === "summarize" ? summaryText : undefined,
      method,
    };
  }
}

export const SUMMARY_PREFIX = "Previous conversation summary: ";

export function isSummaryMessage(m: Message): boolean {
  return (
    m.role === "assistant" &&
    typeof m.content === "string" &&
    m.content.startsWith(SUMMARY_PREFIX)
  );
}

export function extractExistingSummary(messages: Message[]): string | null {
  for (const m of messages) {
    if (isSummaryMessage(m)) {
      return (m.content as string).slice(SUMMARY_PREFIX.length);
    }
  }
  return null;
}

export interface ClassifiedTurn {
  turn: Message[];
  kind: "must-keep-error" | "must-keep-write" | "candidate" | "fold";
  /** True when the turn starts with a user-text message (safe to retain as a unit). */
  complete: boolean;
  /** True when a must-keep-write turn is already a compacted file_change note. */
  alreadyCompacted: boolean;
}

export function classifyMiddleTurns(
  turns: Message[][],
  opts: { selectiveRetention: boolean }
): ClassifiedTurn[] {
  return turns.map((turn) => {
    if (!isUserTextMessage(turn[0])) {
      return { turn, kind: "fold", complete: false, alreadyCompacted: false };
    }
    if (!opts.selectiveRetention) {
      return { turn, kind: "candidate", complete: true, alreadyCompacted: false };
    }
    const hasError = turn.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as ToolResultBlock[]).some((b) => b.is_error)
    );
    if (hasError) {
      return { turn, kind: "must-keep-error", complete: true, alreadyCompacted: false };
    }
    if (turn.some((m) => isFileChangeMessage(m))) {
      return { turn, kind: "must-keep-write", complete: true, alreadyCompacted: true };
    }
    const hasWrite = turn.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as ToolUseBlock[]).some(
          (b) => WRITE_TOOL_NAMES.has(b.name) || EDIT_TOOL_NAMES.has(b.name)
        )
    );
    if (hasWrite) {
      return { turn, kind: "must-keep-write", complete: true, alreadyCompacted: false };
    }
    return { turn, kind: "candidate", complete: true, alreadyCompacted: false };
  });
}
