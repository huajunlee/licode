import type { Message, UserMessage, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import { TokenCounter } from "../llm/token-counter.js";
import type {
  CompressionAssistResult,
  CompressionTurnInput,
} from "./summarizer.js";
import { getRecoveryPointer } from "./git-pointer.js";
import {
  computeStats,
  buildFileChangeMessage,
  isFileChangeMessage,
  WRITE_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  type FileChangeNote,
  type FileChangeOperation,
  type FileChangeStats,
} from "./file-change.js";

export interface ContextCompressorConfig {
  /** Unified side-call: classify candidates, gen file-change descriptors, merge summary. */
  compressionAssistant: {
    assist(input: {
      existingSummary: string | null;
      turns: CompressionTurnInput[];
    }): Promise<CompressionAssistResult>;
  };
  workingDirectory: string;
  rollingSummary?: boolean;
  selectiveRetention?: boolean;
  fileChangeCompaction?: boolean;
  summaryMaxTokens?: number;
}

export interface CompressionResult {
  compressed: boolean;
  removedMessages: number;
  summary?: string;
  method?: "summarize" | "trim" | "rolling";
  retainedTurns?: number;
  compactedTurns?: number;
  summaryUpdated?: boolean;
}

export interface CompressOptions {
  keepRecentTurns: number;
  budgetTokens?: number;
}

/** A real user text message (not a tool_result, which is also role: "user"). */
function isUserTextMessage(m: Message): m is UserMessage {
  return m.role === "user" && typeof m.content === "string";
}

/**
 * Split a message history into turns. A new turn begins at each UserMessage
 * (role "user" with string content). ToolUseMessage/ToolResultMessage pairs
 * always stay within the turn they belong
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

// ---------- Task 5 helpers (unchanged) ----------

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

// ---------- Phase 5: new ContextCompressor ----------

const TRUNCATE_LINES = 50;

function turnText(turn: Message[]): string {
  const parts: string[] = [];
  for (const m of turn) {
    if (typeof m.content === "string") {
      parts.push(`${m.role}: ${m.content}`);
    } else {
      for (const b of m.content as (ToolUseBlock | ToolResultBlock)[]) {
        if ("content" in b) {
          parts.push(`tool_result: ${b.content}`);
        } else {
          parts.push(`tool_use ${b.name}(${JSON.stringify(b.input).slice(0, 200)})`);
        }
      }
    }
  }
  let text = parts.join("\n");
  // Truncate long write content so the side-call input stays bounded.
  const lines = text.split("\n");
  if (lines.length > TRUNCATE_LINES) {
    text = lines.slice(0, TRUNCATE_LINES).join("\n") + `\n…(${lines.length} lines total)`;
  }
  return text;
}

function findWriteToolUse(turn: Message[]): { name: string; input: Record<string, unknown> } | null {
  for (const m of turn) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as ToolUseBlock[]) {
        if (WRITE_TOOL_NAMES.has(b.name) || EDIT_TOOL_NAMES.has(b.name)) {
          return { name: b.name, input: b.input };
        }
      }
    }
  }
  return null;
}

export class ContextCompressor {
  private compressionAssistant: ContextCompressorConfig["compressionAssistant"];
  private workingDirectory: string;
  private rollingSummary: boolean;
  private selectiveRetention: boolean;
  private fileChangeCompaction: boolean;
  private summaryMaxTokens: number;
  private tokenCounter = new TokenCounter();

  constructor(config: ContextCompressorConfig) {
    this.compressionAssistant = config.compressionAssistant;
    this.workingDirectory = config.workingDirectory;
    this.rollingSummary = config.rollingSummary ?? true;
    this.selectiveRetention = config.selectiveRetention ?? true;
    this.fileChangeCompaction = config.fileChangeCompaction ?? true;
    this.summaryMaxTokens = config.summaryMaxTokens ?? 2048;
  }

  async compress(
    conversation: ConversationManager,
    opts: CompressOptions
  ): Promise<CompressionResult> {
    const messages = [...conversation.getMessages()];
    if (messages.length === 0) return { compressed: false, removedMessages: 0 };
    if (!isUserTextMessage(messages[0])) return { compressed: false, removedMessages: 0 };
    const firstUser = messages[0];
    const turns = splitIntoTurns(messages);
    const K = opts.keepRecentTurns;
    if (turns.length <= K) return { compressed: false, removedMessages: 0 };

    const recentTurns = turns.slice(turns.length - K);
    const recentFlat = recentTurns.flat();
    const recentStart = messages.indexOf(recentTurns[0][0]);
    const middleMessages = messages.slice(1, recentStart);

    const existingSummary = this.rollingSummary
      ? extractExistingSummary(middleMessages)
      : null;
    const middleNoSummary = middleMessages.filter((m) => !isSummaryMessage(m));
    const middleTurns = splitIntoTurns(middleNoSummary);
    const classified = classifyMiddleTurns(middleTurns, {
      selectiveRetention: this.selectiveRetention,
    });

    const turnInputs: CompressionTurnInput[] = [];
    // Fold turns (incomplete, no user-text start) don't get a classification
    // index — they are only text for the summary. Classifiable turns are 1-indexed.
    let classifiableIdx = 0;
    for (const c of classified) {
      if (c.kind === "fold") {
        turnInputs.push({ index: 0, kind: c.kind, text: turnText(c.turn) });
        continue;
      }
      classifiableIdx++;
      const base: CompressionTurnInput = { index: classifiableIdx, kind: c.kind, text: turnText(c.turn) };
      if (c.kind === "must-keep-write" && !c.alreadyCompacted) {
        const use = findWriteToolUse(c.turn);
        if (use) {
          const operation: FileChangeOperation = WRITE_TOOL_NAMES.has(use.name) ? "write" : "edit";
          base.writeOperation = operation;
          base.writePath = String(use.input.file_path ?? "");
          base.writeStats = computeStats(operation, use.input);
        }
      }
      turnInputs.push(base);
    }

    let updatedSummary: string;
    let classifications: CompressionAssistResult["classifications"] = [];
    let fileChanges: CompressionAssistResult["fileChanges"] = [];
    let method: "summarize" | "rolling" | "trim";

    try {
      const res = await this.compressionAssistant.assist({
        existingSummary,
        turns: turnInputs,
      });
      updatedSummary = res.updatedSummary;
      classifications = res.classifications;
      fileChanges = res.fileChanges;
      method = existingSummary !== null ? "rolling" : "summarize";
    } catch {
      // Degrade to trim: drop the middle, fold firstUser intent into recent[0].
      method = "trim";
      const kept = [...recentFlat];
      if (isUserTextMessage(kept[0])) {
        kept[0] = {
          ...kept[0],
          content: `[Earlier task: ${firstUser.content}]\n\n${kept[0].content}`,
        };
      }
      conversation.replaceMessages(kept);
      return {
        compressed: true,
        removedMessages: middleMessages.length,
        method,
        summaryUpdated: false,
      };
    }

    const classByIndex = new Map(classifications.map((c) => [c.index, c.keep]));
    const fileChangeByIndex = new Map(fileChanges.map((f) => [f.index, f]));

    const summaryMessage: Message = {
      role: "assistant",
      content: `${SUMMARY_PREFIX}${updatedSummary}`,
      timestamp: new Date().toISOString(),
    };

    const retainedMiddle: Message[] = [];
    const importantTurns: Message[][] = [];
    let compactedTurns = 0;
    let retainedCount = 0;

    // Fold turns do not participate in classification / file-change indexing.
    // Only classifiable turns (non-fold) get 1-based indices that match the
    // assistant's returned classifications and fileChanges.
    let retainIdx = 0;
    for (const c of classified) {
      if (c.kind === "fold") continue; // always folded into summary
      retainIdx++;
      if (c.kind === "must-keep-error") {
        retainedMiddle.push(...c.turn);
        retainedCount++;
        continue;
      }
      if (c.kind === "must-keep-write") {
        if (c.alreadyCompacted || !this.fileChangeCompaction) {
          retainedMiddle.push(...c.turn);
        } else {
          const note = await this.buildNote(c.turn, fileChangeByIndex.get(retainIdx));
          // turn = [userText, assistant(tool_use), user(tool_result), ...] -> [userText, note]
          retainedMiddle.push(c.turn[0], note);
          compactedTurns++;
        }
        retainedCount++;
        continue;
      }
      // candidate
      const keep = classByIndex.get(retainIdx) ?? "normal";
      if (keep === "important") importantTurns.push(c.turn);
    }

    // Budget cut: keep important turns while under budget; else shed (already in summary).
    const importantKept: Message[] = [];
    const base = [firstUser, summaryMessage, ...retainedMiddle, ...recentFlat];
    let kept = [...base];
    const budget = opts.budgetTokens && opts.budgetTokens > 0 ? opts.budgetTokens : Infinity;
    for (const t of importantTurns) {
      const candidate = [...kept, ...t];
      if (this.tokenCounter.estimateMessages(candidate) <= budget) {
        kept = candidate;
        importantKept.push(...t);
        retainedCount++;
      } else {
        break;
      }
    }

    const finalKept = [firstUser, summaryMessage, ...retainedMiddle, ...importantKept, ...recentFlat];
    conversation.replaceMessages(finalKept);

    const removedMessages =
      middleMessages.length -
      (retainedMiddle.length + importantKept.length) +
      compactedTurns; // compacted notes replace N original msgs with 1

    return {
      compressed: true,
      removedMessages: Math.max(0, removedMessages),
      method,
      summary: updatedSummary,
      retainedTurns: retainedCount,
      compactedTurns,
      summaryUpdated: true,
    };
  }

  private async buildNote(
    turn: Message[],
    fc: { symbols?: string[]; summary?: { kind?: string } } | undefined
  ): Promise<Message> {
    const use = findWriteToolUse(turn)!;
    const operation: FileChangeOperation = WRITE_TOOL_NAMES.has(use.name) ? "write" : "edit";
    const filePath = String(use.input.file_path ?? "");
    const stats: FileChangeStats = computeStats(operation, use.input);
    const content =
      operation === "write"
        ? String(use.input.content ?? "")
        : await this.readDisk(filePath);
    const pointer = await getRecoveryPointer(content, this.workingDirectory);
    const note: FileChangeNote = {
      type: "file_change",
      operation,
      path: filePath,
      stats,
      symbols: fc?.symbols ?? [],
      summary: {
        kind: fc?.summary?.kind || (operation === "write" ? "create file" : "edit file"),
      },
      pointer: {
        path: filePath,
        version: pointer.version,
        method: pointer.method,
        ...(pointer.spillPath ? { spillPath: pointer.spillPath } : {}),
      },
    };
    return buildFileChangeMessage(note);
  }

  private async readDisk(filePath: string): Promise<string> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workingDirectory, filePath);
    try {
      return fs.readFileSync(abs, "utf-8");
    } catch {
      return "";
    }
  }
}
