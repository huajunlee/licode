import { describe, it, expect } from "vitest";
import {
  displayWidth,
  truncateToWidth,
  formatSessionRow,
} from "./session-row.js";

const NOW = new Date("2026-07-27T12:00:00");

describe("displayWidth", () => {
  it("counts ASCII as 1 column", () => {
    expect(displayWidth("abc")).toBe(3);
  });

  it("counts CJK as 2 columns", () => {
    expect(displayWidth("修复")).toBe(4);
    expect(displayWidth("＋")).toBe(2);
  });

  it("counts mixed text", () => {
    expect(displayWidth("修 a")).toBe(4);
  });
});

describe("truncateToWidth", () => {
  it("keeps text that fits", () => {
    expect(truncateToWidth("短标题", 10)).toBe("短标题");
  });

  it("truncates with ellipsis reserving 1 column", () => {
    const out = truncateToWidth("修复登录 bug 的详细描述", 10);
    expect(out.endsWith("…")).toBe(true);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
  });
});

describe("formatSessionRow", () => {
  const base = {
    id: "a3f9c21e-1234",
    messageCount: 12,
    updatedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toISOString(),
  };

  it("uses title when present", () => {
    const row = formatSessionRow({ ...base, title: "修复登录 bug" }, 80, NOW);
    expect(row.titleText).toBe("修复登录 bug");
  });

  it("falls back to summary when title is missing", () => {
    const row = formatSessionRow({ ...base, summary: "帮我重构 auth" }, 80, NOW);
    expect(row.titleText).toBe("帮我重构 auth");
  });

  it("falls back to placeholder when neither title nor summary", () => {
    const row = formatSessionRow(base, 80, NOW);
    expect(row.titleText).toBe("（无消息）");
  });

  it("formats id and right column", () => {
    const row = formatSessionRow({ ...base, title: "x" }, 80, NOW);
    expect(row.idText).toBe("a3f9c21e");
    expect(row.rightText).toBe("12 条 · 3 天前");
  });

  it("truncates title so the row fits the given width", () => {
    const row = formatSessionRow(
      { ...base, title: "这是一个非常非常长的会话标题需要被截断处理才行" },
      40,
      NOW
    );
    const total =
      row.idText.length + 3 + displayWidth(row.titleText) + row.titlePad + 2 + displayWidth(row.rightText);
    expect(total).toBeLessThanOrEqual(40);
    expect(row.titleText.endsWith("…")).toBe(true);
  });
});
