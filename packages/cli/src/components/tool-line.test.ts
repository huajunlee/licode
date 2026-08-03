import { describe, it, expect } from "vitest";
import { formatToolLine } from "./tool-line.js";
import { COLORS, ICONS } from "../theme.js";
import { displayWidth } from "./session-row.js";

describe("formatToolLine", () => {
  it("done: success icon/color with truncated inline summary", () => {
    const line = formatToolLine({
      toolName: "Grep",
      status: "done",
      detail: "verifyToken",
      result: "找到 12 处匹配",
    });
    expect(line.icon).toBe(ICONS.toolDone);
    expect(line.color).toBe(COLORS.success);
    expect(line.name).toBe("Grep");
    expect(line.detail).toBe("verifyToken");
    expect(line.summary).toBe("找到 12 处匹配");
  });

  it("running: accent, no summary", () => {
    const line = formatToolLine({ toolName: "Edit", status: "running", detail: "a.ts" });
    expect(line.icon).toBe(ICONS.toolRunning);
    expect(line.color).toBe(COLORS.accent);
    expect(line.summary).toBe("");
  });

  it("pending: muted, no summary", () => {
    const line = formatToolLine({ toolName: "Bash", status: "pending" });
    expect(line.icon).toBe(ICONS.toolPending);
    expect(line.color).toBe(COLORS.muted);
    expect(line.detail).toBe("");
  });

  it("error: error icon/color, no summary (detail expands separately)", () => {
    const line = formatToolLine({ toolName: "Read", status: "error", result: "boom" });
    expect(line.icon).toBe(ICONS.toolError);
    expect(line.color).toBe(COLORS.error);
    expect(line.summary).toBe("");
  });

  it("truncates long CJK summaries to 40 columns", () => {
    const line = formatToolLine({
      toolName: "Read",
      status: "done",
      result: "这是一段非常非常长的结果摘要需要被截断到四十列以内才行确实很长",
    });
    expect(line.summary.endsWith("…")).toBe(true);
    expect(displayWidth(line.summary)).toBeLessThanOrEqual(40);
  });
});
