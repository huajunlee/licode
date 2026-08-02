import { describe, it, expect } from "vitest";
import { buildViewModel } from "./markdown.js";

describe("buildViewModel", () => {
  it("renders # heading as bold accent", () => {
    expect(buildViewModel("# 标题")).toEqual([
      { indent: 0, spans: [{ text: "标题", bold: true, accent: true }] },
    ]);
  });

  it("renders ## heading with faint underline", () => {
    expect(buildViewModel("## 分析")).toEqual([
      { indent: 0, spans: [{ text: "分析", bold: true, accent: true }] },
      { indent: 0, spans: [{ text: "────", faint: true }] },
    ]);
  });

  it("renders ### heading as bold without accent", () => {
    expect(buildViewModel("### 细节")).toEqual([
      { indent: 0, spans: [{ text: "细节", bold: true }] },
    ]);
  });

  it("renders unordered list items with bullet and indent 2", () => {
    expect(buildViewModel("- 甲\n- 乙")).toEqual([
      { indent: 2, spans: [{ text: "• " }, { text: "甲" }] },
      { indent: 2, spans: [{ text: "• " }, { text: "乙" }] },
    ]);
  });

  it("renders ordered list items keeping numbers", () => {
    expect(buildViewModel("1. 先\n2. 后")).toEqual([
      { indent: 2, spans: [{ text: "1. " }, { text: "先" }] },
      { indent: 2, spans: [{ text: "2. " }, { text: "后" }] },
    ]);
  });

  it("indents nested list items by 2 per level", () => {
    expect(buildViewModel("- 外\n  - 内")).toEqual([
      { indent: 2, spans: [{ text: "• " }, { text: "外" }] },
      { indent: 4, spans: [{ text: "• " }, { text: "内" }] },
    ]);
  });

  it("renders inline code as accent span", () => {
    expect(buildViewModel("调用 `verifyToken()` 试试")).toEqual([
      {
        indent: 0,
        spans: [
          { text: "调用 " },
          { text: "verifyToken()", accent: true },
          { text: " 试试" },
        ],
      },
    ]);
  });

  it("renders fenced code block with border prefix and language label", () => {
    expect(buildViewModel("```ts\nconst a = 1;\nconst b = 2;\n```")).toEqual([
      { indent: 0, spans: [{ text: "┌ ", faint: true }, { text: "ts", muted: true }] },
      { indent: 0, spans: [{ text: "│ ", faint: true }, { text: "const a = 1;" }] },
      { indent: 0, spans: [{ text: "│ ", faint: true }, { text: "const b = 2;" }] },
    ]);
  });

  it("renders unclosed fenced block as code (streaming tolerance)", () => {
    expect(buildViewModel("```\npartial")).toEqual([
      { indent: 0, spans: [{ text: "┌ ", faint: true }] },
      { indent: 0, spans: [{ text: "│ ", faint: true }, { text: "partial" }] },
    ]);
  });

  it("renders bold and italic inline", () => {
    expect(buildViewModel("这是 **重点** 和 *强调*")).toEqual([
      {
        indent: 0,
        spans: [
          { text: "这是 " },
          { text: "重点", bold: true },
          { text: " 和 " },
          { text: "强调", italic: true },
        ],
      },
    ]);
  });

  it("renders links as text + faint url", () => {
    expect(buildViewModel("见 [文档](https://example.com) 这里")).toEqual([
      {
        indent: 0,
        spans: [
          { text: "见 " },
          { text: "文档" },
          { text: " https://example.com", faint: true },
          { text: " 这里" },
        ],
      },
    ]);
  });

  it("renders blockquote with border prefix and muted text", () => {
    expect(buildViewModel("> 注意这一点")).toEqual([
      { indent: 0, spans: [{ text: "│ ", faint: true }, { text: "注意这一点", muted: true }] },
    ]);
  });

  it("renders hr as fixed 40-column faint line", () => {
    expect(buildViewModel("---")).toEqual([
      { indent: 0, spans: [{ text: "─".repeat(40), faint: true }] },
    ]);
  });

  it("passes tables through as raw lines", () => {
    expect(buildViewModel("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([
      { indent: 0, spans: [{ text: "| a | b |" }] },
      { indent: 0, spans: [{ text: "|---|---|" }] },
      { indent: 0, spans: [{ text: "| 1 | 2 |" }] },
    ]);
  });

  it("splits soft line breaks into separate lines", () => {
    expect(buildViewModel("第一行\n第二行")).toEqual([
      { indent: 0, spans: [{ text: "第一行" }] },
      { indent: 0, spans: [{ text: "第二行" }] },
    ]);
  });

  it("keeps blank lines between paragraphs", () => {
    expect(buildViewModel("甲\n\n乙")).toEqual([
      { indent: 0, spans: [{ text: "甲" }] },
      { indent: 0, spans: [] },
      { indent: 0, spans: [{ text: "乙" }] },
    ]);
  });

  it("passes plain text through unchanged", () => {
    expect(buildViewModel("就是一句话")).toEqual([
      { indent: 0, spans: [{ text: "就是一句话" }] },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(buildViewModel("")).toEqual([]);
  });
});
