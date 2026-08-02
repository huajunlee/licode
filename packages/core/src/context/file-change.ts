import type { Message } from "../llm/provider.js";

export type FileChangeOperation = "write" | "edit";

export interface FileChangeStats {
  added: number;
  removed: number;
}

export interface FileChangeNote {
  type: "file_change";
  operation: FileChangeOperation;
  path: string;
  stats: FileChangeStats;
  symbols: string[];
  summary: { kind: string };
  pointer: {
    path: string;
    version: string;
    method: "git" | "spill";
    spillPath?: string;
  };
}

export const FILE_CHANGE_PREFIX = "file_change ";
export const WRITE_TOOL_NAMES = new Set(["Write", "write"]);
export const EDIT_TOOL_NAMES = new Set(["Edit", "edit"]);

export function lineCount(s: string): number {
  if (s.length === 0) return 0;
  return s.split("\n").length;
}

export function computeStats(
  operation: FileChangeOperation,
  input: Record<string, unknown>
): FileChangeStats {
  if (operation === "write") {
    return { added: lineCount(String(input.content ?? "")), removed: 0 };
  }
  return {
    added: lineCount(String(input.new_string ?? "")),
    removed: lineCount(String(input.old_string ?? "")),
  };
}

export function buildFileChangeMessage(note: FileChangeNote): Message {
  return {
    role: "assistant",
    content: `${FILE_CHANGE_PREFIX}${JSON.stringify(note)}`,
    timestamp: new Date().toISOString(),
  };
}

export function isFileChangeMessage(m: Message): boolean {
  return (
    m.role === "assistant" &&
    typeof m.content === "string" &&
    m.content.startsWith(FILE_CHANGE_PREFIX)
  );
}

export function parseFileChangeMessage(m: Message): FileChangeNote | null {
  if (!isFileChangeMessage(m)) return null;
  try {
    return JSON.parse((m.content as string).slice(FILE_CHANGE_PREFIX.length)) as FileChangeNote;
  } catch {
    return null;
  }
}
