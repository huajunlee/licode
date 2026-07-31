import { describe, expect, it } from "vitest";
import type { Message } from "../llm/provider.js";
import {
  FILE_CHANGE_PREFIX,
  WRITE_TOOL_NAMES,
  computeStats,
  buildFileChangeMessage,
  isFileChangeMessage,
  parseFileChangeMessage,
} from "./file-change.js";

describe("file-change", () => {
  it("computes stats for write (all added) and edit (hunk diff)", () => {
    expect(computeStats("write", { content: "a\nb\nc" })).toEqual({ added: 3, removed: 0 });
    expect(computeStats("edit", { old_string: "a\nb", new_string: "a\nb\nc\nd" })).toEqual({
      added: 4,
      removed: 2,
    });
    expect(computeStats("write", { content: "" })).toEqual({ added: 0, removed: 0 });
  });

  it("builds an assistant message whose content is the file_change note JSON", () => {
    const msg = buildFileChangeMessage({
      type: "file_change",
      operation: "edit",
      path: "src/a.ts",
      stats: { added: 4, removed: 2 },
      symbols: ["foo"],
      summary: { kind: "add foo" },
      pointer: { path: "src/a.ts", version: "deadbeef", method: "git" },
    });
    expect(msg.role).toBe("assistant");
    expect(typeof msg.content).toBe("string");
    expect((msg.content as string).startsWith(FILE_CHANGE_PREFIX)).toBe(true);
  });

  it("detects and round-trips a file_change message", () => {
    const note = {
      type: "file_change" as const,
      operation: "write" as const,
      path: "x.txt",
      stats: { added: 1, removed: 0 },
      symbols: [],
      summary: { kind: "create" },
      pointer: { path: "x.txt", version: "abc", method: "spill" as const, spillPath: ".licode/overflow/abc.txt" },
    };
    const msg = buildFileChangeMessage(note);
    expect(isFileChangeMessage(msg)).toBe(true);
    expect(isFileChangeMessage({ role: "assistant", content: "hello", timestamp: "" })).toBe(false);
    expect(parseFileChangeMessage(msg)).toEqual(note);
    expect(parseFileChangeMessage({ role: "assistant", content: "hello", timestamp: "" })).toBeNull();
  });

  it("WRITE_TOOL_NAMES contains Write", () => {
    expect(WRITE_TOOL_NAMES.has("Write")).toBe(true);
  });
});
