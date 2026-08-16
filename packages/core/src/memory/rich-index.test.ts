import { describe, it, expect } from "vitest";
import { buildRichIndex } from "./rich-index.js";
import type { Memory } from "./types.js";

const mem = (over: Partial<Memory>): Memory => ({
  name: "食物偏好",
  slug: "user/food-preferences",
  description: "用户喜欢蛋挞，不吃辣",
  content: "用户喜欢吃蛋挞，尤其宵夜。\n不吃辣。",
  keywords: ["蛋挞", "饮食"],
  ...over,
} as Memory);

describe("buildRichIndex", () => {
  it("formats one entry per memory with keywords and first-line preview", () => {
    const out = buildRichIndex([mem({})]);
    expect(out).toBe(
      "- [食物偏好](user/food-preferences.md) - 用户喜欢蛋挞，不吃辣 [关键词: 蛋挞,饮食] 「用户喜欢吃蛋挞，尤其宵夜。」"
    );
  });

  it("truncates first line preview at 60 chars with ellipsis", () => {
    const long = "一".repeat(70);
    const out = buildRichIndex([mem({ content: long })]);
    expect(out).toContain(`「${"一".repeat(60)}…」`);
  });

  it("omits keywords bracket when keywords missing or empty", () => {
    const out = buildRichIndex([mem({ keywords: undefined })]);
    expect(out).not.toContain("[关键词:");
  });

  it("joins multiple memories with newline", () => {
    const out = buildRichIndex([mem({}), mem({ slug: "project/x", name: "X" })]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
