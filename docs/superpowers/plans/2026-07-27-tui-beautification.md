# TUI 美化（极简现代）Implementation Plan

> ## ⚠ 修订状态（2026-08-02）
>
> 本计划初版基于 2026-07-27 的 master。2026-08-02 已将 master（+126 commit，含日记系统 / decide / memory / context）合并进本分支（merge commit `938cc2c`，无冲突），并据此重新裁定。详见 spec `2026-07-27-tui-beautification-design.md` §9。
>
> **任务状态**：
> - Task 0–4：✅ 已完成并提交（marked 依赖 / 主题 v2 / banner / markdown 视图模型 / MarkdownText 渲染器）
> - Task 5：🟡 半完成（`relative-time.test.ts` 已写未跟踪，缺 `relative-time.ts` 实现 -> 当前 `pnpm build` 唯一红点）
> - Task 6–13、15：❌ 未做，按原计划执行
> - **Task 14 修订**：在原 Task 14 基础上新增"Enter 选中"（见文末"Task 14 修订"）
> - **Task B（新增）**：`/diary` 日记模式风格切换（见文末"Task B"）
> - **Task A（基线）**：merge 已解决 dream-indicator 缺失；`startup.test.ts` 的 MCP mock 失败为 master 既有 / 环境依赖，与本计划无关、不阻断
>
> **基线**：`pnpm build` 仅 `relative-time.test.ts` 红（Task 5 完成即绿）；`pnpm test` 615 绿 / 1 红（startup MCP，既有）。
>
> 下方原计划正文（Task 0–15）保留作参考；执行以本修订状态 + spec §9–§12 为准。


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 LICode CLI 的欢迎屏与对话屏重设计为"极简现代"风格——ASCII Art 横幅、Markdown 真渲染、布局降噪、几何图标替代 emoji。

**Architecture:** 改动集中在 `packages/cli`（`@licode/core` 仅 `listSessions` 增量返回 `summary` 字段）。Markdown 用 `marked.lexer()` 解析后经纯函数转成视图模型，再渲染为 Ink 原生元素树。所有展示逻辑（视图模型、时间、行格式化）下沉为可单测纯函数；组件只做粘合。

**Tech Stack:** Ink v5 + React 18 + TypeScript；新增依赖 `marked`（仅 packages/cli）；vitest。

**Spec:** `docs/superpowers/specs/2026-07-27-tui-beautification-design.md`

## Global Constraints

- **TDD 纪律：** 每个任务先写失败测试（RED）→ 最小实现（GREEN）→ 重构 → commit。组件粘合层（无测试基础设施）用 `pnpm build`（tsc）+ 既有测试全绿作为验证。
- **图标禁令：** 新代码不得出现 ≥U+1F000 码点、FE0F 变体选择符，及以下字符：⏳ 🤔 🆕 📖 🔍 ✏ ⚙ ⚠
- **调色板：** 只用规格 §2.1 的 7 个 hex 值（accent `#E5A567`、text `#C8CCD8`、muted `#8A8F9E`、faint `#565B68`、success `#9ECE6A`、warning `#E0AF68`、error `#F7768E`），不再新增颜色
- **测试命令（worktree 根目录）：** 单文件 `npx vitest run <path>`；全量 `pnpm test`；类型检查 `pnpm build`
- **Commit 风格：** Conventional Commits（`feat(cli):`、`test(cli):`、`refactor(cli):`、`feat(core):`）
- **执行环境：** 本 worktree 无 `node_modules`，Task 0 必须先 `pnpm install`

---

### Task 0: 环境准备

**Files:**
- Modify: `packages/cli/package.json`（加入 marked 依赖）

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/lixiaohua/Project/agent/LICode/.claude/worktrees/tui-beautification
pnpm install
pnpm --filter @licode/cli add marked
```

Expected: `packages/cli/package.json` 的 dependencies 出现 `"marked": "^..."`；`pnpm test` 能跑通既有测试（全绿基线）。

- [ ] **Step 2: 确认基线全绿**

Run: `pnpm test`
Expected: 全部既有测试 PASS（无任何失败）

- [ ] **Step 3: Commit**

```bash
git add packages/cli/package.json pnpm-lock.yaml
git commit -m "chore(cli): add marked dependency for markdown rendering"
```

---

### Task 1: Theme 2.0 — 调色板与图标集重写

**Files:**
- Modify: `packages/cli/src/theme.ts`（整体重写）
- Test: `packages/cli/src/theme.test.ts`（整体重写）

**Interfaces:**
- Produces（后续所有任务依赖）:
  - `COLORS`: `{ accent, text, muted, faint, success, warning, error }`（外加过渡期 legacy 键，Task 15 删除）
  - `ICONS`: `{ prompt:"❯", assistant:"◆", toolDone:"●", toolRunning:"◐", toolPending:"○", toolError:"✗", inlineOk:"✓", expand:"▸", newSession:"＋", codeBorder:"│", separator:"─", spinnerFrames: string[10] }`（外加过渡期 legacy 键）
  - `BORDERS`、`SPACING`：保留为 `@deprecated` 过渡导出，Task 15 删除

- [ ] **Step 1: 重写失败测试（RED）**

完整替换 `packages/cli/src/theme.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { COLORS, ICONS } from "./theme.js";

const REMOVED_EMOJI = ["⏳", "🤔", "🆕", "📖", "🔍", "✏", "⚙"];

describe("theme tokens", () => {
  describe("COLORS", () => {
    it("matches the minimal-modern palette", () => {
      expect(COLORS).toMatchObject({
        accent: "#E5A567",
        text: "#C8CCD8",
        muted: "#8A8F9E",
        faint: "#565B68",
        success: "#9ECE6A",
        warning: "#E0AF68",
        error: "#F7768E",
      });
    });

    it("all color values are hex truecolor strings", () => {
      for (const [key, value] of Object.entries(COLORS)) {
        expect(value, `COLORS.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });
  });

  describe("ICONS", () => {
    it("spinnerFrames has exactly 10 unique frames", () => {
      expect(ICONS.spinnerFrames).toHaveLength(10);
      expect(new Set(ICONS.spinnerFrames).size).toBe(10);
    });

    it("no icon contains removed emoji", () => {
      for (const [key, value] of Object.entries(ICONS)) {
        if (typeof value !== "string") continue;
        for (const emoji of REMOVED_EMOJI) {
          expect(value.includes(emoji), `ICONS.${key} contains ${emoji}`).toBe(false);
        }
      }
    });

    it("no icon contains emoji-range codepoints or variation selectors", () => {
      for (const [key, value] of Object.entries(ICONS)) {
        if (typeof value !== "string") continue;
        expect(
          /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u.test(value),
          `ICONS.${key} has emoji-range codepoint`
        ).toBe(false);
      }
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/theme.test.ts`
Expected: FAIL — `COLORS.accent` 等键不存在（toMatchObject 断言失败）

- [ ] **Step 3: 重写 theme.ts（GREEN）**

完整替换 `packages/cli/src/theme.ts`：

```ts
/**
 * LICode Theme System
 *
 * Central design tokens for all terminal UI components.
 * Every visual constant in the app is defined here.
 * Components import from this file instead of using hardcoded strings.
 */

// ---- Semantic Color Palette ----
// Truecolor hex values. chalk (used by Ink) degrades automatically
// to 256/16-color terminals — no manual fallback needed.

export const COLORS = {
  /** Warm amber: prompt ❯, selection, inline code, running state, banner */
  accent: "#E5A567",
  /** Primary body text */
  text: "#C8CCD8",
  /** Secondary text: labels, tool details, summaries */
  muted: "#8A8F9E",
  /** Weakest: help lines, separators, session ids, status bar */
  faint: "#565B68",
  /** Tool done ●, inline ✓ */
  success: "#9ECE6A",
  /** Command messages */
  warning: "#E0AF68",
  /** Errors, failed tools ✗ */
  error: "#F7768E",

  // ---- Legacy aliases (transitional — removed in final cleanup task) ----
  /** @deprecated use accent */ primary: "#E5A567",
  /** @deprecated use accent */ info: "#E5A567",
  /** @deprecated use muted */ toolPending: "#8A8F9E",
  /** @deprecated use accent */ toolRunning: "#E5A567",
  /** @deprecated use success */ toolDone: "#9ECE6A",
  /** @deprecated use error */ toolError: "#F7768E",
  /** @deprecated use faint */ toolCardBorder: "#565B68",
  /** @deprecated use error */ toolCardBorderError: "#F7768E",
} as const;

// ---- Icons ----
// Geometric unicode only — no emoji. Width-stable across terminals.

export const ICONS = {
  /** Input prompt, selection cursor, user message prefix */
  prompt: "❯",
  /** Assistant turn marker */
  assistant: "◆",
  toolDone: "●",
  toolRunning: "◐",
  toolPending: "○",
  toolError: "✗",
  inlineOk: "✓",
  /** Focused thinking-accordion item */
  expand: "▸",
  /** Fullwidth plus — aligns with CJK text */
  newSession: "＋",
  /** Code block / quote left border */
  codeBorder: "│",
  /** Separator line unit */
  separator: "─",

  /** Braille spinner animation frames (10 frames) */
  spinnerFrames: [
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
  ] as readonly string[],

  // ---- Legacy aliases (transitional — removed in final cleanup task) ----
  /** @deprecated use toolPending */ pending: "○",
  /** @deprecated use toolRunning */ running: "◐",
  /** @deprecated use toolDone */ success: "●",
  /** @deprecated use toolError */ error: "✗",
} as const;

// ---- Legacy exports (transitional — removed in final cleanup task) ----

/** @deprecated borders are being removed from the design */
export const BORDERS = { popup: "single", card: "round" } as const;

/** @deprecated use inline spacing values */
export const SPACING = { xs: 1, sm: 1, md: 2, lg: 4 } as const;
```

- [ ] **Step 4: 运行测试确认通过 + 全量回归**

Run: `npx vitest run packages/cli/src/theme.test.ts && pnpm test && pnpm build`
Expected: theme 测试 PASS；全量 PASS；tsc 编译通过（legacy 别名保证旧 import 不破）

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/theme.ts packages/cli/src/theme.test.ts
git commit -m "feat(cli): rewrite theme with truecolor palette and geometric icons

Legacy aliases kept temporarily so existing components still compile;
they are removed in the final cleanup task."
```

---

### Task 2: ASCII Art 横幅资产

**Files:**
- Create: `packages/cli/src/banner.ts`
- Test: `packages/cli/src/banner.test.ts`

**Interfaces:**
- Produces:
  - `BANNER_LINES: readonly string[]` — 5 行、等宽、纯 ASCII（Task 8 欢迎屏消费）
  - `TAGLINE: string` — `"终端里的 AI 编程伙伴"`（Task 8 消费）

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/banner.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { BANNER_LINES, TAGLINE } from "./banner.js";

describe("banner", () => {
  it("has exactly 5 art lines", () => {
    expect(BANNER_LINES).toHaveLength(5);
  });

  it("all lines have equal width", () => {
    const widths = new Set(BANNER_LINES.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("fits narrow terminals (<= 60 columns)", () => {
    for (const line of BANNER_LINES) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("is pure ASCII (codepoints <= 127)", () => {
    for (const line of BANNER_LINES) {
      for (const ch of line) {
        expect(ch.charCodeAt(0)).toBeLessThanOrEqual(127);
      }
    }
  });

  it("tagline is non-empty", () => {
    expect(TAGLINE.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/banner.test.ts`
Expected: FAIL — 模块 `./banner.js` 不存在

- [ ] **Step 3: 实现 banner.ts（GREEN）**

创建 `packages/cli/src/banner.ts`（注意反斜杠在 TS 字符串中需要转义）：

```ts
/**
 * ASCII art banner printed on the welcome screen (Spring Boot style).
 * Pure ASCII, equal-width lines, safe for narrow terminals.
 */

const RAW_LINES = [
  " _      ___   ____           _",
  "| |    |_ _| / ___|___    __| | ___",
  "| |     | | | |   / _ \\  / _` |/ _ \\",
  "| |___  | | | |__| (_) || (_| |  __/",
  "|_____|___| \\____\\___/  \\__,_|\\___|",
] as const;

const WIDTH = Math.max(...RAW_LINES.map((l) => l.length));

/** Equal-width banner lines, right-padded with spaces. */
export const BANNER_LINES: readonly string[] = RAW_LINES.map((l) =>
  l.padEnd(WIDTH)
);

export const TAGLINE = "终端里的 AI 编程伙伴";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/src/banner.test.ts`
Expected: 5 个用例全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/banner.ts packages/cli/src/banner.test.ts
git commit -m "feat(cli): add Spring-style ASCII art banner asset"
```

---

### Task 3: Markdown 视图模型（markdown.ts）

**Files:**
- Create: `packages/cli/src/components/markdown.ts`
- Test: `packages/cli/src/components/markdown.test.ts`

**Interfaces:**
- Consumes: `marked` 的 `lexer`（Task 0 已安装）
- Produces（Task 4、9、10 消费）:
  - `interface MdSpan { text: string; bold?: boolean; italic?: boolean; accent?: boolean; muted?: boolean; faint?: boolean }`
  - `interface MdLine { indent: number; spans: MdSpan[] }`
  - `buildViewModel(source: string): MdLine[]` — 任何输入不抛异常；lexer 失败时按纯文本透传

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/markdown.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/markdown.test.ts`
Expected: FAIL — 模块 `./markdown.js` 不存在

- [ ] **Step 3: 实现 markdown.ts（GREEN）**

创建 `packages/cli/src/components/markdown.ts`：

```ts
/**
 * Markdown → view model.
 *
 * Parsing is delegated to marked's lexer (CommonMark/GFM tolerant —
 * an unclosed fence simply runs to end of input, which is exactly what
 * streaming needs). The view model is plain data so it can be unit
 * tested without a renderer; markdown-text.tsx turns it into Ink
 * elements.
 */

import { lexer, type Token, type Tokens } from "marked";

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code, # / ## headings — theme accent color */
  accent?: boolean;
  /** Quote body, code language label — theme muted color */
  muted?: boolean;
  /** Prefixes │ ┌, underlines, hr, link urls — theme faint color */
  faint?: boolean;
}

export interface MdLine {
  indent: number;
  spans: MdSpan[];
}

const HR_LINE = "─".repeat(40);
const H2_UNDERLINE = "────";

export function buildViewModel(source: string): MdLine[] {
  let tokens: Token[];
  try {
    tokens = lexer(source);
  } catch {
    return source.split("\n").map((text) => ({ indent: 0, spans: [{ text }] }));
  }
  const lines: MdLine[] = [];
  emitBlockTokens(tokens, 0, lines);
  return lines;
}

function emitBlockTokens(tokens: Token[], indent: number, out: MdLine[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const spans = parseInline(heading.tokens).map((s) => ({
          ...s,
          bold: true,
          accent: heading.depth <= 2 ? true : s.accent,
        }));
        out.push({ indent, spans });
        if (heading.depth === 2) {
          out.push({ indent, spans: [{ text: H2_UNDERLINE, faint: true }] });
        }
        break;
      }
      case "paragraph": {
        pushWrapped(out, indent, parseInline((token as Tokens.Paragraph).tokens));
        break;
      }
      case "list": {
        emitList(token as Tokens.List, indent, out);
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const label: MdSpan[] = code.lang ? [{ text: code.lang, muted: true }] : [];
        out.push({ indent, spans: [{ text: "┌ ", faint: true }, ...label] });
        for (const text of code.text.split("\n")) {
          out.push({ indent, spans: [{ text: "│ ", faint: true }, { text }] });
        }
        break;
      }
      case "blockquote": {
        const inner: MdLine[] = [];
        emitBlockTokens((token as Tokens.Blockquote).tokens, 0, inner);
        for (const line of inner) {
          out.push({
            indent,
            spans: [
              { text: "│ ", faint: true },
              ...line.spans.map((s) => ({ ...s, muted: true })),
            ],
          });
        }
        break;
      }
      case "hr": {
        out.push({ indent, spans: [{ text: HR_LINE, faint: true }] });
        break;
      }
      case "space": {
        out.push({ indent, spans: [] });
        break;
      }
      default: {
        // Tables, html, and anything else: pass the raw source through.
        const raw = (token as { raw?: string }).raw ?? "";
        for (const text of raw.replace(/\n$/, "").split("\n")) {
          if (text) out.push({ indent, spans: [{ text }] });
        }
      }
    }
  }
}

function emitList(list: Tokens.List, indent: number, out: MdLine[]): void {
  const start = typeof list.start === "number" ? list.start : 1;
  list.items.forEach((item, i) => {
    const marker = list.ordered ? `${start + i}. ` : "• ";
    let markerUsed = false;
    for (const sub of item.tokens) {
      if (sub.type === "list") {
        emitBlockTokens([sub], indent + 2, out);
      } else if (sub.type === "text" || sub.type === "paragraph") {
        const spans = parseInline((sub as Tokens.Text).tokens ?? []);
        pushWrapped(out, indent + 2, markerUsed ? spans : [{ text: marker }, ...spans]);
        markerUsed = true;
      } else {
        emitBlockTokens([sub], indent + 2, out);
      }
    }
    if (!markerUsed) out.push({ indent: indent + 2, spans: [{ text: marker }] });
  });
}

function parseInline(tokens: Token[] | undefined): MdSpan[] {
  if (!tokens) return [];
  const spans: MdSpan[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        spans.push({ text: (t as Tokens.Text).text });
        break;
      case "strong":
        spans.push(...parseInline((t as Tokens.Strong).tokens).map((s) => ({ ...s, bold: true })));
        break;
      case "em":
        spans.push(...parseInline((t as Tokens.Em).tokens).map((s) => ({ ...s, italic: true })));
        break;
      case "codespan":
        spans.push({ text: (t as Tokens.Codespan).text, accent: true });
        break;
      case "link": {
        const link = t as Tokens.Link;
        spans.push({ text: link.text }, { text: ` ${link.href}`, faint: true });
        break;
      }
      case "br":
        spans.push({ text: "\n" });
        break;
      default: {
        const text = (t as { text?: string }).text;
        if (typeof text === "string") spans.push({ text });
      }
    }
  }
  return spans;
}

/** Push spans as one line, splitting into multiple lines at embedded \n. */
function pushWrapped(out: MdLine[], indent: number, spans: MdSpan[]): void {
  let current: MdSpan[] = [];
  const flush = () => {
    out.push({ indent, spans: current });
    current = [];
  };
  for (const span of spans) {
    span.text.split("\n").forEach((part, i) => {
      if (i > 0) flush();
      if (part) current.push({ ...span, text: part });
    });
  }
  flush();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/src/components/markdown.test.ts`
Expected: 18 个用例全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/markdown.ts packages/cli/src/components/markdown.test.ts
git commit -m "feat(cli): add markdown view-model builder on top of marked lexer"
```

---

### Task 4: MarkdownText 组件（Ink 渲染器）

**Files:**
- Create: `packages/cli/src/components/markdown-text.tsx`

**Interfaces:**
- Consumes: `buildViewModel`、`MdSpan`（Task 3）；`COLORS`（Task 1）
- Produces: `<MarkdownText>{source: string}</MarkdownText>` — Task 9（chat-view）、Task 10（stream-renderer）消费

- [ ] **Step 1: 实现组件**

创建 `packages/cli/src/components/markdown-text.tsx`：

```tsx
import React from "react";
import { Box, Text } from "ink";
import { buildViewModel, type MdSpan } from "./markdown.js";
import { COLORS } from "../theme.js";

interface MarkdownTextProps {
  children: string;
}

function spanColor(span: MdSpan): string | undefined {
  if (span.accent) return COLORS.accent;
  if (span.muted) return COLORS.muted;
  if (span.faint) return COLORS.faint;
  return undefined;
}

export function MarkdownText({ children }: MarkdownTextProps) {
  const lines = buildViewModel(children);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} marginLeft={line.indent}>
          <Text>
            {line.spans.map((span, j) => (
              <Text
                key={j}
                color={spanColor(span)}
                bold={span.bold}
                italic={span.italic}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: 验证（组件层无测试库，用 tsc + 全量回归）**

Run: `pnpm build && pnpm test`
Expected: 编译通过；全部测试 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/components/markdown-text.tsx
git commit -m "feat(cli): add Ink-native MarkdownText renderer component"
```

---

### Task 5: 相对时间纯函数

**Files:**
- Create: `packages/cli/src/components/relative-time.ts`
- Test: `packages/cli/src/components/relative-time.test.ts`

**Interfaces:**
- Produces: `relativeTime(iso: string, now: Date): string` — Task 7（session-row）消费

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/relative-time.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time.js";

const NOW = new Date("2026-07-27T12:00:00");

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("relativeTime", () => {
  it("just now under 60 seconds", () => {
    expect(relativeTime(ago(0), NOW)).toBe("刚刚");
    expect(relativeTime(ago(59_000), NOW)).toBe("刚刚");
  });

  it("minutes under 60 minutes", () => {
    expect(relativeTime(ago(60_000), NOW)).toBe("1 分钟前");
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe("59 分钟前");
  });

  it("hours under 24 hours", () => {
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1 小时前");
    expect(relativeTime(ago(23 * 60 * 60_000), NOW)).toBe("23 小时前");
  });

  it("days under 30 days", () => {
    expect(relativeTime(ago(24 * 60 * 60_000), NOW)).toBe("1 天前");
    expect(relativeTime(ago(29 * 24 * 60 * 60_000), NOW)).toBe("29 天前");
  });

  it("absolute date at 30+ days", () => {
    expect(relativeTime("2026-06-20T08:00:00", NOW)).toBe("2026/6/20");
  });

  it("clamps future dates to 刚刚", () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("刚刚");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/relative-time.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现（GREEN）**

创建 `packages/cli/src/components/relative-time.ts`：

```ts
/** Format an ISO timestamp as Chinese relative time. `now` is injected for testability. */
export function relativeTime(iso: string, now: Date): string {
  const diffSec = Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso).getTime()) / 1000)
  );
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/src/components/relative-time.test.ts`
Expected: 6 个用例全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/relative-time.ts packages/cli/src/components/relative-time.test.ts
git commit -m "feat(cli): add relative-time formatter for session list"
```

---

### Task 6: core — listSessions 增量返回 summary

**Files:**
- Modify: `packages/core/src/conversation/manager.ts`（`listSessions` 方法 + 新增私有函数）
- Test: `packages/core/src/conversation/manager.test.ts`（追加 describe）

**Interfaces:**
- Produces: `ConversationManager.listSessions()` 返回项新增 `summary?: string` — 首条 string 内容 user 消息（`\s+` 折叠为单空格，截断 200 字符）；无则 `undefined`。Task 8 的 `SessionInfo` 消费。

- [ ] **Step 1: 写失败测试（RED）**

在 `packages/core/src/conversation/manager.test.ts` 中 `listSessions returns empty array for non-existent dir` 用例之后追加：

```ts
describe("listSessions summary", () => {
  it("extracts summary from the first string-content user message", async () => {
    const dir = path.join(tmpDir, ".licode", "sessions-summary");
    fs.mkdirSync(dir, { recursive: true });

    const mgr = new ConversationManager({ id: "s-sum", model: "m" });
    mgr.addUserMessage("修复登录 bug\n涉及 verifyToken");
    await mgr.save(path.join(dir, "s-sum.json"));

    const sessions = await ConversationManager.listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe("修复登录 bug 涉及 verifyToken");
  });

  it("returns undefined summary when no user message exists", async () => {
    const dir = path.join(tmpDir, ".licode", "sessions-nosummary");
    fs.mkdirSync(dir, { recursive: true });

    const mgr = new ConversationManager({ id: "s-empty", model: "m" });
    await mgr.save(path.join(dir, "s-empty.json"));

    const sessions = await ConversationManager.listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBeUndefined();
  });
});
```

（沿用该文件已有的 `tmpDir`、`fs`、`path` import 与 `ConversationManager` 用法。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/src/conversation/manager.test.ts`
Expected: FAIL — `sessions[0].summary` 为 undefined（第一个用例断言失败）

- [ ] **Step 3: 实现（GREEN）**

在 `packages/core/src/conversation/manager.ts` 中：

1. `SessionFile` 接口之后添加：

```ts
function extractSummary(messages: Message[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      const summary = msg.content.replace(/\s+/g, " ").trim();
      if (summary) return summary.slice(0, 200);
    }
  }
  return undefined;
}
```

2. `listSessions` 的两处返回类型注解（第 233-242 行与第 250-257 行的对象类型字面量）各加一行 `summary?: string;`。
3. `sessions.push({...})` 的对象字面量中加一行 `summary: extractSummary(data.messages),`。

- [ ] **Step 4: 运行测试确认通过 + core 全量回归**

Run: `npx vitest run packages/core/src/conversation/manager.test.ts && pnpm test`
Expected: 新增 2 用例 PASS；全量 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/manager.ts packages/core/src/conversation/manager.test.ts
git commit -m "feat(core): add additive summary field to listSessions result"
```

---

### Task 7: 会话行格式化纯函数（session-row.ts）

**Files:**
- Create: `packages/cli/src/components/session-row.ts`
- Test: `packages/cli/src/components/session-row.test.ts`

**Interfaces:**
- Consumes: `relativeTime`（Task 5）
- Produces（Task 8 消费；Task 11 复用 `truncateToWidth`）:
  - `displayWidth(text: string): number` — CJK/全角计 2 列
  - `truncateToWidth(text: string, maxCols: number): string` — 超宽末尾截断加 `…`
  - `interface SessionRowData { id; title?; summary?; messageCount; updatedAt }`
  - `interface SessionRow { idText; titleText; rightText; titlePad }`
  - `formatSessionRow(session: SessionRowData, width: number, now: Date): SessionRow`

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/session-row.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/session-row.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现（GREEN）**

创建 `packages/cli/src/components/session-row.ts`：

```ts
import { relativeTime } from "./relative-time.js";

export interface SessionRowData {
  id: string;
  title?: string;
  summary?: string;
  messageCount: number;
  updatedAt: string;
}

export interface SessionRow {
  /** 8-char short id — render faint */
  idText: string;
  /** Title / summary / placeholder, truncated to fit — render normal */
  titleText: string;
  /** "N 条 · 3 天前" — render faint, right-aligned */
  rightText: string;
  /** Spaces to pad after titleText so rightText lands right-aligned */
  titlePad: number;
}

function charWidth(cp: number): number {
  if (cp >= 0x2e80 && cp <= 0x9fff) return 2; // CJK radicals .. CJK unified
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compat ideographs
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
  if (cp >= 0x20000) return 2; // CJK ext B and beyond
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export function truncateToWidth(text: string, maxCols: number): string {
  if (displayWidth(text) <= maxCols) return text;
  let result = "";
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (width + w > maxCols - 1) break; // reserve 1 column for …
    result += ch;
    width += w;
  }
  return result + "…";
}

const ID_GAP = 3; // columns between id and title
const RIGHT_GAP = 2; // columns between title and right column

export function formatSessionRow(
  session: SessionRowData,
  width: number,
  now: Date
): SessionRow {
  const idText = session.id.slice(0, 8);
  const rightText = `${session.messageCount} 条 · ${relativeTime(session.updatedAt, now)}`;
  const rawTitle = session.title?.trim() || session.summary || "（无消息）";
  const titleCols = Math.max(
    1,
    width - idText.length - ID_GAP - RIGHT_GAP - displayWidth(rightText)
  );
  const titleText = truncateToWidth(rawTitle, titleCols);
  const titlePad = titleCols - displayWidth(titleText);
  return { idText, titleText, rightText, titlePad };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/src/components/session-row.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/session-row.ts packages/cli/src/components/session-row.test.ts
git commit -m "feat(cli): add session row formatter with CJK-aware width math"
```

---

### Task 8: 欢迎屏重排（app.tsx + session-list + welcome-input）

**Files:**
- Modify: `packages/cli/src/components/use-session-selector.ts:17-24`（SessionInfo 加 `summary?: string`）
- Modify: `packages/cli/src/components/session-list.tsx`（重写渲染）
- Modify: `packages/cli/src/components/welcome-input.tsx`（提示符统一）
- Modify: `packages/cli/src/app.tsx:133-163`（欢迎屏布局）

**Interfaces:**
- Consumes: `BANNER_LINES`、`TAGLINE`（Task 2）；`formatSessionRow`、`displayWidth`（Task 7）；`COLORS`、`ICONS`（Task 1）
- Produces: 无新接口（`SessionList` props 不变）

- [ ] **Step 1: SessionInfo 加字段**

`use-session-selector.ts` 的 `SessionInfo` 接口加一行：

```ts
export interface SessionInfo {
  id: string;
  title?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
}
```

- [ ] **Step 2: 重写 session-list.tsx**

完整替换：

```tsx
import React from "react";
import { Box, Text, useStdout } from "ink";
import type { VisibleItem } from "./use-session-selector.js";
import type { SessionInfo } from "./use-session-selector.js";
import { formatSessionRow } from "./session-row.js";
import { COLORS, ICONS } from "../theme.js";

interface SessionListProps {
  visibleItems: VisibleItem<SessionInfo>[];
  totalCount: number;
  windowStart: number;
  /** Whether the "+ 新建会话" virtual item is active */
  showCreateNew?: boolean;
  /** Is the cursor currently on the new-session item? */
  isOnNewSession?: boolean;
}

export function SessionList({
  visibleItems,
  totalCount,
  windowStart,
  showCreateNew = false,
  isOnNewSession = false,
}: SessionListProps) {
  const { stdout } = useStdout();
  // App padding (1 col each side) + list indent (2 cols each side)
  const width = (stdout?.columns ?? 80) - 6;
  const now = new Date();

  const truncatedTop = windowStart > 0;
  const truncatedBottom = windowStart + visibleItems.length < totalCount;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginLeft={2} marginBottom={1}>
        <Text color={COLORS.faint}>最近会话</Text>
      </Box>

      {showCreateNew && (
        <Box marginLeft={2}>
          <Text color={isOnNewSession ? COLORS.accent : undefined} bold={isOnNewSession}>
            {isOnNewSession ? `${ICONS.prompt} ` : "  "}
            {ICONS.newSession} 新建会话
          </Text>
        </Box>
      )}

      {truncatedTop && (
        <Box marginLeft={2}>
          <Text color={COLORS.faint}>… 上方还有 {windowStart} 个会话</Text>
        </Box>
      )}

      {visibleItems.map(({ item: s, isCursor }) => {
        const row = formatSessionRow(s, width, now);
        return (
          <Box key={s.id} marginLeft={2}>
            <Text color={isCursor ? COLORS.accent : undefined} bold={isCursor}>
              {isCursor ? `${ICONS.prompt} ` : "  "}
              <Text color={COLORS.faint} bold={false}>{row.idText}</Text>
              {"   "}
              {row.titleText}
              {" ".repeat(row.titlePad + 2)}
              <Text color={COLORS.faint} bold={false}>{row.rightText}</Text>
            </Text>
          </Box>
        );
      })}

      {truncatedBottom && (
        <Box marginLeft={2}>
          <Text color={COLORS.faint}>
            … 下方还有 {totalCount - windowStart - visibleItems.length} 个会话
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 3: welcome-input.tsx 提示符统一**

把 `<Text color={COLORS.primary}>{"> "}</Text>` 改为：

```tsx
<Text color={COLORS.accent}>{ICONS.prompt} </Text>
```

（`COLORS` import 同步改为 `{ COLORS, ICONS }`。）

- [ ] **Step 4: app.tsx 欢迎屏布局**

`isWelcome` 分支的 return 替换为：

```tsx
  if (isWelcome) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {BANNER_LINES.map((line, i) => (
            <Text key={i} color={COLORS.accent}>{line}</Text>
          ))}
          <Text color={COLORS.faint}>  {TAGLINE} · v0.1.0</Text>
        </Box>
        <SessionList
          visibleItems={visibleItems}
          totalCount={sessions.length}
          windowStart={windowStart}
          showCreateNew={true}
          isOnNewSession={isOnNewSession}
        />
        <Box marginTop={1}>
          <Text color={COLORS.faint}>
            ↑↓ 选择 · enter 进入 · ctrl+n 新建 · --session {"<id>"} 恢复
          </Text>
        </Box>
        {welcomeError && (
          <Box marginTop={1}>
            <Text color={COLORS.error}>{welcomeError}</Text>
          </Box>
        )}
        <WelcomeInput onSubmit={handleWelcomeSubmit} />
      </Box>
    );
  }
```

（删除旧的 `LICode v0.1.0` 标题行与"📖 新用户指南"行；`app.tsx` 顶部 import 增加 `import { BANNER_LINES, TAGLINE } from "./banner.js";`）

- [ ] **Step 5: 验证**

Run: `pnpm build && pnpm test`
Expected: 编译通过；全量 PASS（session-selector 既有测试不受影响）

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/components/use-session-selector.ts packages/cli/src/components/session-list.tsx packages/cli/src/components/welcome-input.tsx packages/cli/src/app.tsx
git commit -m "feat(cli): redesign welcome screen with banner and column-aligned session list"
```

---

### Task 9: 消息分类纯函数 + chat-view 重写

**Files:**
- Create: `packages/cli/src/components/message-classify.ts`
- Test: `packages/cli/src/components/message-classify.test.ts`
- Modify: `packages/cli/src/components/chat-view.tsx`（重写）

**Interfaces:**
- Consumes: `Message`（@licode/core）；`MarkdownText`（Task 4）；`COLORS`、`ICONS`（Task 1）
- Produces:
  - `classifyMessage(msg: Message): "system" | "user" | "assistant-text" | "tool-use" | "tool-result"`
  - `toolNames(msg: Message): string` — `"name1, name2"`

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/message-classify.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { classifyMessage, toolNames } from "./message-classify.js";
import type { Message } from "@licode/core";

const userMsg: Message = { role: "user", content: "你好", timestamp: "" } as Message;
const assistantMsg: Message = { role: "assistant", content: "回答", timestamp: "" } as Message;
const systemMsg: Message = { role: "system", content: "sys" } as Message;
const toolUseMsg: Message = {
  role: "assistant",
  content: [{ id: "t1", name: "Read", input: {} }, { id: "t2", name: "Grep", input: {} }],
  timestamp: "",
} as Message;
const toolResultMsg: Message = {
  role: "user",
  content: [{ tool_use_id: "t1", content: "ok" }],
  timestamp: "",
} as Message;

describe("classifyMessage", () => {
  it("classifies the five message shapes", () => {
    expect(classifyMessage(userMsg)).toBe("user");
    expect(classifyMessage(assistantMsg)).toBe("assistant-text");
    expect(classifyMessage(systemMsg)).toBe("system");
    expect(classifyMessage(toolUseMsg)).toBe("tool-use");
    expect(classifyMessage(toolResultMsg)).toBe("tool-result");
  });
});

describe("toolNames", () => {
  it("joins tool names", () => {
    expect(toolNames(toolUseMsg)).toBe("Read, Grep");
  });

  it("returns empty string for string content", () => {
    expect(toolNames(userMsg)).toBe("");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/message-classify.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 message-classify.ts（GREEN）**

创建 `packages/cli/src/components/message-classify.ts`：

```ts
import type { Message } from "@licode/core";

export type MessageKind =
  | "system"
  | "user"
  | "assistant-text"
  | "tool-use"
  | "tool-result";

export function classifyMessage(msg: Message): MessageKind {
  if (msg.role === "system") return "system";
  if (typeof msg.content === "string") {
    return msg.role === "user" ? "user" : "assistant-text";
  }
  return msg.role === "assistant" ? "tool-use" : "tool-result";
}

export function toolNames(msg: Message): string {
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((b) => ("name" in b ? String(b.name) : ""))
    .filter(Boolean)
    .join(", ");
}
```

- [ ] **Step 4: 运行测试确认通过后，重写 chat-view.tsx**

Run: `npx vitest run packages/cli/src/components/message-classify.test.ts`（应 PASS）

完整替换 `packages/cli/src/components/chat-view.tsx`：

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Message } from "@licode/core";
import { classifyMessage, toolNames } from "./message-classify.js";
import { MarkdownText } from "./markdown-text.js";
import { COLORS, ICONS } from "../theme.js";

interface ChatViewProps {
  messages: Message[];
}

export function ChatView({ messages }: ChatViewProps) {
  const visible = messages.filter((m) => {
    const kind = classifyMessage(m);
    return kind === "user" || kind === "assistant-text" || kind === "tool-use";
  });

  if (visible.length === 0) {
    return (
      <Box marginBottom={1}>
        <Text color={COLORS.faint}>开始对话…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((msg, i) => {
        const kind = classifyMessage(msg);

        if (kind === "user") {
          return (
            <Box key={i} marginTop={1}>
              <Text color={COLORS.accent}>{ICONS.prompt} </Text>
              <Text>{msg.content as string}</Text>
            </Box>
          );
        }

        if (kind === "tool-use") {
          return (
            <Box key={i} marginLeft={2}>
              <Text color={COLORS.muted}>
                {ICONS.toolDone} 调用工具: {toolNames(msg)}
              </Text>
            </Box>
          );
        }

        // assistant-text: ◆ marker aligned with the first content line
        return (
          <Box key={i} marginTop={1}>
            <Text color={COLORS.accent}>{ICONS.assistant} </Text>
            <MarkdownText>{msg.content as string}</MarkdownText>
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 5: 验证**

Run: `pnpm build && pnpm test`
Expected: 编译通过；全量 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/components/message-classify.ts packages/cli/src/components/message-classify.test.ts packages/cli/src/components/chat-view.tsx
git commit -m "feat(cli): restyle chat view with markdown rendering and turn markers"
```

---

### Task 10: 流式输出走 Markdown

**Files:**
- Modify: `packages/cli/src/components/stream-renderer.tsx`

**Interfaces:**
- Consumes: `MarkdownText`（Task 4）；`COLORS`（Task 1）
- Produces: 无新接口（props 不变 `{ text: string }`）

- [ ] **Step 1: 重写组件**

完整替换 `packages/cli/src/components/stream-renderer.tsx`：

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./markdown-text.js";
import { COLORS } from "../theme.js";

interface StreamRendererProps {
  text: string;
}

export function StreamRenderer({ text }: StreamRendererProps) {
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  if (!text) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <MarkdownText>{text}</MarkdownText>
      {showCursor && <Text color={COLORS.accent}>█</Text>}
    </Box>
  );
}
```

（光标改为独占一行跟在内容后——流式期间可接受；思考：不要尝试把光标拼进最后一行，MarkdownText 是块级结构。）

- [ ] **Step 2: 验证**

Run: `pnpm build && pnpm test`
Expected: 编译通过；全量 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/components/stream-renderer.tsx
git commit -m "feat(cli): render streaming output through MarkdownText"
```

---

### Task 11: 工具调用单行化（tool-call-card.tsx）

**Files:**
- Create: `packages/cli/src/components/tool-line.ts`
- Test: `packages/cli/src/components/tool-line.test.ts`
- Modify: `packages/cli/src/components/tool-call-card.tsx`（重写）

**Interfaces:**
- Consumes: `truncateToWidth`（Task 7）；`COLORS`、`ICONS`（Task 1）
- Produces:
  - `ToolCallStatus`、`ToolCallState`（从 tool-call-card.tsx 移至 tool-line.ts；`tool-call-card.tsx` 用 `export type { ToolCallStatus, ToolCallState } from "./tool-line.js"` re-export——`hooks.ts:34` 现有 `import type { ToolCallState } from "./components/tool-call-card.js"` 因此不破）
  - `formatToolLine(call: ToolCallState): { icon: string; color: string; name: string; detail: string; summary: string }`

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/tool-line.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/tool-line.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 tool-line.ts（GREEN）**

创建 `packages/cli/src/components/tool-line.ts`：

```ts
import { COLORS, ICONS } from "../theme.js";
import { truncateToWidth } from "./session-row.js";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallState {
  toolName: string;
  status: ToolCallStatus;
  detail?: string;
  result?: string;
}

export interface ToolLine {
  icon: string;
  color: string;
  name: string;
  /** Truncated to 40 columns; "" when absent */
  detail: string;
  /** Only for done — truncated to 40 columns; "" otherwise */
  summary: string;
}

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: ICONS.toolPending,
  running: ICONS.toolRunning,
  done: ICONS.toolDone,
  error: ICONS.toolError,
};

const STATUS_COLORS: Record<ToolCallStatus, string> = {
  pending: COLORS.muted,
  running: COLORS.accent,
  done: COLORS.success,
  error: COLORS.error,
};

export function formatToolLine(call: ToolCallState): ToolLine {
  return {
    icon: STATUS_ICONS[call.status],
    color: STATUS_COLORS[call.status],
    name: call.toolName,
    detail: call.detail ? truncateToWidth(call.detail, 40) : "",
    summary:
      call.status === "done" && call.result
        ? truncateToWidth(call.result, 40)
        : "",
  };
}

/** Char-based truncate kept for error expansion (200 chars). */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
```

- [ ] **Step 4: 运行测试确认通过后，重写 tool-call-card.tsx**

Run: `npx vitest run packages/cli/src/components/tool-line.test.ts`（应 PASS）

完整替换 `packages/cli/src/components/tool-call-card.tsx`：

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { formatToolLine, truncate } from "./tool-line.js";
import type { ToolCallState } from "./tool-line.js";
import { COLORS, ICONS } from "../theme.js";

export type { ToolCallStatus, ToolCallState } from "./tool-line.js";

interface ToolCallCardProps extends ToolCallState {
  /** Braille frame shown next to running tools */
  spinnerFrame?: string;
}

export function ToolCallCard({
  toolName,
  status,
  detail,
  result,
  spinnerFrame,
}: ToolCallCardProps) {
  const line = formatToolLine({ toolName, status, detail, result });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={line.color}>{line.icon} </Text>
        <Text bold>{line.name}</Text>
        {line.detail !== "" && <Text color={COLORS.muted}>  {line.detail}</Text>}
        {status === "done" && <Text color={COLORS.success}> {ICONS.inlineOk}</Text>}
        {line.summary !== "" && <Text color={COLORS.muted}> {line.summary}</Text>}
        {status === "running" && (
          <Text color={COLORS.muted}> 运行中 {spinnerFrame ?? ""}</Text>
        )}
      </Box>
      {status === "error" && result && (
        <Box marginLeft={4}>
          <Text color={COLORS.error}>{truncate(result, 200)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function ToolCallCards({ calls }: { calls: ToolCallState[] }) {
  const [frame, setFrame] = useState(0);
  const anyRunning = calls.some((c) => c.status === "running");

  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % ICONS.spinnerFrames.length),
      100
    );
    return () => clearInterval(timer);
  }, [anyRunning]);

  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      {calls.map((call, i) => (
        <ToolCallCard
          key={`${call.toolName}-${i}`}
          {...call}
          spinnerFrame={ICONS.spinnerFrames[frame]}
        />
      ))}
    </Box>
  );
}
```

- [ ] **Step 5: 验证**

Run: `pnpm build && pnpm test`
Expected: 编译通过（hooks.ts 的 ToolCallState import 经 re-export 兼容）；全量 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/components/tool-line.ts packages/cli/src/components/tool-line.test.ts packages/cli/src/components/tool-call-card.tsx
git commit -m "feat(cli): replace bordered tool cards with single-line status rows"
```

---

### Task 12: 状态栏极简化（status-bar.tsx）

**Files:**
- Create: `packages/cli/src/components/status-line.ts`
- Test: `packages/cli/src/components/status-line.test.ts`
- Modify: `packages/cli/src/components/status-bar.tsx`（重写）

**Interfaces:**
- Produces:
  - `formatTokens(n: number): string`（从 status-bar.tsx 移入，千分位）
  - `formatStatusWide(model: string, tokens: number, sessionId: string): string` → `"model · 1,234 tok · a3f9c21e"`
  - `formatStatusNarrow(model: string, tokens: number): string` → `"model · 1,234 tok"`

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/status-line.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { formatTokens, formatStatusWide, formatStatusNarrow } from "./status-line.js";

describe("formatTokens", () => {
  it("uses thousands separators", () => {
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatStatusWide", () => {
  it("joins model, tokens and 8-char session id", () => {
    expect(formatStatusWide("deepseek-v4-pro", 1234, "a3f9c21e-9999")).toBe(
      "deepseek-v4-pro · 1,234 tok · a3f9c21e"
    );
  });
});

describe("formatStatusNarrow", () => {
  it("drops session id", () => {
    expect(formatStatusNarrow("deepseek-v4-pro", 1234)).toBe(
      "deepseek-v4-pro · 1,234 tok"
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/status-line.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 status-line.ts + 重写 status-bar.tsx（GREEN）**

创建 `packages/cli/src/components/status-line.ts`：

```ts
export function formatTokens(n: number): string {
  return n.toLocaleString();
}

export function formatStatusWide(
  model: string,
  tokens: number,
  sessionId: string
): string {
  return `${model} · ${formatTokens(tokens)} tok · ${sessionId.slice(0, 8)}`;
}

export function formatStatusNarrow(model: string, tokens: number): string {
  return `${model} · ${formatTokens(tokens)} tok`;
}
```

完整替换 `packages/cli/src/components/status-bar.tsx`：

```tsx
import React from "react";
import { Box, Text, useStdout } from "ink";
import { formatStatusWide, formatStatusNarrow } from "./status-line.js";
import { COLORS, ICONS } from "../theme.js";

interface StatusBarProps {
  model: string;
  tokens: number;
  sessionId: string;
}

export function StatusBar({ model, tokens, sessionId }: StatusBarProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const line =
    cols < 60
      ? formatStatusNarrow(model, tokens)
      : formatStatusWide(model, tokens, sessionId);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.faint}>{ICONS.separator.repeat(Math.max(10, cols - 2))}</Text>
      <Text color={COLORS.faint}>{line}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: 验证**

Run: `npx vitest run packages/cli/src/components/status-line.test.ts && pnpm build && pnpm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/status-line.ts packages/cli/src/components/status-line.test.ts packages/cli/src/components/status-bar.tsx
git commit -m "feat(cli): slim status bar to separator plus single info line"
```

---

### Task 13: Thinking 手风琴去 emoji

**Files:**
- Modify: `packages/cli/src/components/thinking-accordion.tsx`（标签 + 流式行 + 颜色）
- Test: `packages/cli/src/components/thinking-accordion.test.ts`（追加 1 个用例）

**Interfaces:**
- Produces: `inferPurpose(reasoning: string): string` — 签名不变，返回值去 emoji（"读取代码 / 搜索代码库 / 编辑文件 / 分析逻辑 / 思考中"）。既有测试的 `toMatch(/读取/)` 等断言保持通过。

- [ ] **Step 1: 追加失败测试（RED）**

在 `thinking-accordion.test.ts` 末尾的 describe 内追加：

```ts
  it("purpose labels contain no emoji", () => {
    const samples = [
      "read the file",
      "搜索一下",
      "edit this file",
      "analyze the bug",
      "xyzzy flobble",
    ];
    for (const s of samples) {
      expect(inferPurpose(s)).not.toMatch(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]|⏳|⚙/u
      );
    }
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/thinking-accordion.test.ts`
Expected: 新用例 FAIL（现有标签含 📖 🔍 ✏️ 🤔）

- [ ] **Step 3: 修改 thinking-accordion.tsx（GREEN）**

1. `CATEGORIES` 与 `FALLBACK_PURPOSE` 去 emoji：

```ts
const CATEGORIES: Array<[RegExp, string]> = [
  [/\b(read|look|view)|读取|看看|查看|浏览|阅读|检查/, "读取代码"],
  [/\b(search|find|grep|locate)|搜索|查找|寻找|找找|定位/, "搜索代码库"],
  [/\b(edit|modify|writ|updat|chang|fix|refactor|implement)|修改|改|编辑|写|重写|更新|实现|修复|添加|删除/, "编辑文件"],
  [/\b(analyz|analys|understand|debug|diagnos|investigat|think|reason)|分析|理解|了解|调试|思考|推理|排查/, "分析逻辑"],
];

const FALLBACK_PURPOSE = "思考中";
```

2. 组件渲染部分：流式行改为"思考中… + braille spinner 帧"（需要计时器），聚焦项颜色改用新 token：

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { COLORS, ICONS } from "../theme.js";

// ... inferPurpose / CATEGORIES 同上 ...

export function ThinkingAccordion({ blocks, focusedIndex }: ThinkingAccordionProps) {
  const [frame, setFrame] = useState(0);
  const anyStreaming = blocks.some((b) => b.isStreaming);

  useEffect(() => {
    if (!anyStreaming) return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % ICONS.spinnerFrames.length),
      100
    );
    return () => clearInterval(timer);
  }, [anyStreaming]);

  if (blocks.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={1}>
      {blocks.map((block, i) => {
        const isFocused = i === focusedIndex;
        const isExpanded = isFocused;

        return (
          <Box key={block.id} flexDirection="column">
            <Box>
              <Text
                color={isFocused ? COLORS.accent : COLORS.muted}
              >
                {isFocused ? `${ICONS.expand} ` : "  "}
                {block.isStreaming
                  ? `思考中… ${ICONS.spinnerFrames[frame]}`
                  : block.purpose}
              </Text>
            </Box>
            {isExpanded && block.reasoning.length > 0 && (
              <Box marginLeft={4} marginBottom={1}>
                <Text color={COLORS.muted}>{block.reasoning}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/src/components/thinking-accordion.test.ts && pnpm build && pnpm test`
Expected: 全部 PASS（含既有 toMatch 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/thinking-accordion.tsx packages/cli/src/components/thinking-accordion.test.ts
git commit -m "feat(cli): de-emoji thinking accordion labels and streaming row"
```

---

### Task 14: 输入区与建议面板（input-box.tsx）

**Files:**
- Modify: `packages/cli/src/components/input-box.tsx`

**Interfaces:**
- Consumes: `COLORS`、`ICONS`（Task 1）
- Produces: 无新接口（props 不变）

- [ ] **Step 1: 重写渲染部分**

`input-box.tsx` 的 return 部分替换为（逻辑 hooks 全部保留）：

```tsx
  return (
    <Box flexDirection="column">
      {showSuggestions && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2}>
          {suggestions.map((cmd, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box key={cmd.name}>
                <Text color={isSelected ? COLORS.accent : undefined}>
                  {isSelected ? `${ICONS.prompt} ` : "  "}
                  <Text bold={isSelected}>{cmd.name}</Text>
                  {"  "}
                  <Text color={isSelected ? undefined : COLORS.muted}>
                    {cmd.description.length > 60
                      ? cmd.description.slice(0, 60) + "…"
                      : cmd.description}
                  </Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box>
        <Text color={disabled ? COLORS.faint : COLORS.accent}>{ICONS.prompt} </Text>
        <TextInput
          value={value}
          onChange={(v) => {
            if (v.includes("\t")) {
              completeSuggestion();
              return;
            }
            setValue(v);
            setSelectedIndex(0);
            if (historyIndexRef.current !== historyRef.current.length) {
              historyIndexRef.current = historyRef.current.length;
            }
          }}
          onSubmit={handleSubmit}
        />
        {loading && (
          <Text color={COLORS.muted}> {ICONS.spinnerFrames[spinnerFrame]}</Text>
        )}
      </Box>
      <Box>
        <Text color={COLORS.faint}>
          {loading
            ? "等待回复完成…"
            : disabled
            ? "ctrl+↑↓ 查看推理 · enter 收起"
            : showSuggestions
            ? "tab 补全 · ↑↓ 选择 · enter 发送"
            : "enter 发送 · / 命令 · ctrl+q 返回"}
        </Text>
      </Box>
    </Box>
  );
```

loading 的 braille 帧需要在组件内加计时器（放在组件顶部，与其他 hooks 并列）：

```tsx
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(
      () => setSpinnerFrame((f) => (f + 1) % ICONS.spinnerFrames.length),
      100
    );
    return () => clearInterval(timer);
  }, [loading]);
```

（`React, { useState, useRef, useMemo, useEffect }` import 补齐 useEffect；删除 `BORDERS` import。）

- [ ] **Step 2: 验证**

Run: `pnpm build && pnpm test`
Expected: 编译通过；全量 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/components/input-box.tsx
git commit -m "feat(cli): borderless suggestions, braille loading, compressed hints"
```

---

### Task 15: 收尾 — 删除 legacy token、cli.ts 去 emoji、全面验收

**Files:**
- Modify: `packages/cli/src/theme.ts`（删除 legacy 别名）
- Test: `packages/cli/src/theme.test.ts`（追加断言）
- Modify: `packages/cli/src/cli.ts:227`（⚠️ 替换）

- [ ] **Step 1: 确认无残留引用（先查证）**

Run: `grep -rn "COLORS\.\(primary\|info\|toolPending\|toolRunning\|toolDone\|toolError\|toolCardBorder\|toolCardBorderError\)\|BORDERS\|SPACING\|ICONS\.\(pending\|running\|success\|error\)" packages/cli/src --include="*.tsx" --include="*.ts" | grep -v theme.ts`
Expected: 无输出（所有组件已迁移）。如有输出，先修掉再继续。

- [ ] **Step 2: 追加失败测试（RED）**

在 `theme.test.ts` 的 `describe("COLORS")` 内追加：

```ts
    it("exposes only the minimal-modern palette keys", () => {
      expect(Object.keys(COLORS).sort()).toEqual([
        "accent", "error", "faint", "muted", "success", "text", "warning",
      ]);
    });
```

Run: `npx vitest run packages/cli/src/theme.test.ts`
Expected: 新用例 FAIL（legacy 键仍存在）

- [ ] **Step 3: 删除 legacy 导出（GREEN）**

`theme.ts` 中删除：COLORS 的 8 个 legacy 键、ICONS 的 4 个 legacy 键、`BORDERS`、`SPACING` 全部 legacy 段。

- [ ] **Step 4: cli.ts 警告去 emoji**

`cli.ts` 第 227 行附近：

```ts
    console.error(
      "提示：未设置 ANTHROPIC_BASE_URL。如果你用的不是 Anthropic 官方 API，请设置：\n" +
        "   export ANTHROPIC_BASE_URL=\"https://your-api-endpoint\"\n" +
        "   例如 DeepSeek: export ANTHROPIC_BASE_URL=\"https://api.deepseek.com/anthropic\"\n"
    );
```

- [ ] **Step 5: emoji 全面清扫**

Run: `grep -rn "⏳\|🤔\|🆕\|📖\|🔍\|✏️\|⚙\|⚠️" packages/cli/src --include="*.ts" --include="*.tsx"`
Expected: 无输出（macOS 自带 grep 无 `-P`，用字面字符匹配；完整 emoji 区间已由 theme.test.ts 的 ICONS 断言兜底）

- [ ] **Step 6: 全面验收**

Run: `pnpm test && pnpm build`
Expected: 全量 PASS；编译通过

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/theme.ts packages/cli/src/theme.test.ts packages/cli/src/cli.ts
git commit -m "refactor(cli): remove legacy theme tokens and last emoji"
```

- [ ] **Step 8: 手工验证（用户检查点）**

请用户运行 `pnpm start`，对照规格 §5、§6 的 mockup 检查：
- 欢迎屏：ASCII banner（accent 色）、列对齐会话列表、单行帮助文本
- 对话屏：❯ 用户消息、◆ 助手 Markdown 渲染（标题/列表/代码块/内联代码）、单行工具状态、细分隔线状态栏
- 另开一个 16 色终端（如 Terminal.app 默认 profile）确认降级可用

---

## Self-Review 记录

**Spec coverage：**
- §2 主题 → Task 1 + Task 15 ✓
- §3 Banner → Task 2（资产）+ Task 8（接入）✓
- §4 Markdown → Task 3（视图模型）+ Task 4（渲染器）+ Task 9/10（应用）✓
- §5 欢迎屏 → Task 5/6/7/8 ✓
- §6.1 消息分层 → Task 9 ✓；§6.2 工具行 → Task 11 ✓；§6.3 thinking → Task 13 ✓；§6.4 状态栏 → Task 12 ✓；§6.5 输入区 → Task 14 ✓
- §7 兼容性 → chalk 降级（Task 1 注释）、lexer fallback（Task 3）、useStdout 窄终端（Task 8/12）、（无消息）占位（Task 7）、流式容错（Task 3 测试）✓
- §8 TDD → 每个纯函数任务 RED→GREEN；验收 → Task 15 ✓
- core summary → Task 6 ✓

**类型一致性：** `MdSpan/MdLine/buildViewModel`（Task 3→4）；`BANNER_LINES/TAGLINE`（Task 2→8）；`relativeTime`（5→7）；`displayWidth/truncateToWidth/formatSessionRow`（7→8、7→11）；`formatToolLine/ToolCallState`（11，经 re-export 兼容 hooks.ts）；`formatStatusWide/Narrow/formatTokens`（12）；`classifyMessage/toolNames`（9）；`COLORS/ICONS` 键名贯穿一致 ✓


---

## Task 14 修订：建议面板 Enter 选中（优先级 #1）

> 在原 Task 14（input-box 边框/braille/提示行）之上**新增** Enter 选中行为。原 Task 14 的样式改造仍执行；本节补交互。

**Files:**
- Create: `packages/cli/src/components/should-select-suggestion.ts`
- Test: `packages/cli/src/components/should-select-suggestion.test.ts`
- Modify: `packages/cli/src/components/input-box.tsx`（handleSubmit 守卫 + 提示文案）

**Interfaces:**
- Produces: `shouldSelectSuggestion(value: string, suggestions: {name:string}[]): boolean` - 当面板有项时返回 true（Enter 应选中而非发送）

- [ ] **Step 1: 写失败测试（RED）**

创建 `packages/cli/src/components/should-select-suggestion.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { shouldSelectSuggestion } from "./should-select-suggestion.js";

describe("shouldSelectSuggestion", () => {
  it("true when input starts with / and suggestions exist", () => {
    expect(shouldSelectSuggestion("/di", [{ name: "/diary" }])).toBe(true);
  });
  it("false when no suggestions", () => {
    expect(shouldSelectSuggestion("/zzz", [])).toBe(false);
  });
  it("false when input does not start with /", () => {
    expect(shouldSelectSuggestion("hello", [{ name: "/diary" }])).toBe(false);
  });
});
```
> 设计抉择：面板为空时 Enter 应**发送**（无项可选）。故判定 = `value.startsWith("/") && suggestions.length > 0`（无项则不拦截，正常发送）。

- [ ] **Step 2: 实现（GREEN）**

`packages/cli/src/components/should-select-suggestion.ts`：
```ts
export function shouldSelectSuggestion(
  value: string,
  suggestions: { name: string }[]
): boolean {
  return value.startsWith("/") && suggestions.length > 0;
}
```

- [ ] **Step 3: 接入 handleSubmit（input-box.tsx）**

在 `handleSubmit` 最前面：
```ts
const handleSubmit = (text: string) => {
  if (shouldSelectSuggestion(value, suggestions)) {
    completeSuggestion();
    return; // 不发送
  }
  if (!text.trim() || loading) return;
  // ...原逻辑
};
```
提示文案 `showSuggestions` 分支改为：`Enter 选中 · 再按 Enter 发送 · Tab 补全 · ↑↓ 选择`。

- [ ] **Step 4: 验证 + Commit**

Run: `npx vitest run packages/cli/src/components/should-select-suggestion.test.ts && pnpm build && pnpm test`
Expected: 新测试 PASS；tsc 通过；全量 PASS（startup MCP 既有失败忽略）

```bash
git add packages/cli/src/components/should-select-suggestion.ts packages/cli/src/components/should-select-suggestion.test.ts packages/cli/src/components/input-box.tsx
git commit -m "feat(cli): Enter selects suggestion instead of sending (priority #1)"
```

---

## Task B：/diary 日记模式风格切换（优先级 #2）

> 新增。依赖 Task 1（diaryAccent）、Task 14（diary 模式下 InputBox 样式）。详见 spec §11。

**Files:**
- Modify: `packages/cli/src/theme.ts`（加 `diaryAccent`）
- Test: `packages/cli/src/theme.test.ts`（追加 diaryAccent 断言）
- Create: `packages/cli/src/components/diary-state.ts`（纯函数 reducer）
- Test: `packages/cli/src/components/diary-state.test.ts`
- Modify: `packages/cli/src/hooks.ts`（diaryMode/segments/date 状态 + 暴露）
- Create: `packages/cli/src/components/diary-page.tsx`（日记卡片边框组件）
- Modify: `packages/cli/src/app.tsx`（diaryMode 时渲染 DiaryPage 替换 ChatView 区）
- Modify: `packages/cli/src/components/status-bar.tsx`（diaryMode tint）

- [ ] **Step 1: theme 加 diaryAccent（RED->GREEN）**

`theme.ts` COLORS 加 `diaryAccent: "#7DC9BF"`；`theme.test.ts` 追加 `expect(COLORS.diaryAccent).toMatch(/^#[0-9A-Fa-f]{6}$/)`。

- [ ] **Step 2: diaryStateReducer 纯函数（RED->GREEN）**

`diary-state.ts`：
```ts
export interface DiaryState { mode: boolean; segments: {content:string}[]; date: string; }
export function nextDiaryState(input: string, prev: DiaryState, session: {date:string; segments:{content:string}[]} | null, wasEnd: boolean): DiaryState
```
- 进入（`/diary` 提交、session 非 null、prev.mode=false）：`{mode:true, segments:[], date:session.date}`
- 捕获（session 非 null、prev.mode=true、非 end）：`{mode:true, segments:[...session.segments], date:prev.date}`
- 结束（wasEnd）：`{mode:false, segments:[], date:""}`
单测三态 + 边界。

- [ ] **Step 3: hooks.ts 状态提升**

在 `handleDiaryInput` 返回非 null 分支（约 623-648 行），按 `nextDiaryState` 结果 `setDiaryMode/setDiarySegments/setDiaryDate`。保留 `diarySessionRef` 给 dispatch。从 `useConversation` 返回值暴露三者。

- [ ] **Step 4: DiaryPage 组件**

`diary-page.tsx`：borderStyle="round" 的 Box，标题 `✎ 日记 · {date}`（diaryAccent）；内含 segments（缩进 2）、commandMessage（✓）、InputBox（diary 样式：`✎` 提示符 + 日记 hint `口述经历 · /diary-end 结束 · Esc 取消`）。

- [ ] **Step 5: app.tsx 接线**

ChatApp：`diaryMode` 为真时 return `<DiaryPage .../>` 替换 ChatView+indicators+InputBox 区域；StatusBar 保留并传 `diaryMode`。`Ctrl+Q`（goBack）时同时清 diary 状态。

- [ ] **Step 6: status-bar tint**

`status-bar.tsx` 接 `diaryMode?: boolean`，分割线颜色 `diaryMode ? COLORS.diaryAccent : COLORS.faint`。

- [ ] **Step 7: 验证 + Commit**

Run: `npx vitest run packages/cli/src/components/diary-state.test.ts packages/cli/src/theme.test.ts && pnpm build && pnpm test`
Expected: 全绿（startup MCP 既有失败忽略）

```bash
git add -A packages/cli/src
git commit -m "feat(cli): /diary mode framed journal-page style switch (priority #2)"
```

- [ ] **Step 8: 手工验证（用户检查点）**

`pnpm start` -> `/diary` 进入 -> 整屏切青绿 + 日记卡片边框 + ✎ 提示符 -> 口述片段逐条显示 -> `/diary-end` 切回正常。

---

## Task A：基线修复（合并后已最小化）

> merge 已解决 dream-indicator 缺失。剩余仅"补 Task 5 实现"让 build 转绿。

- [ ] 完成 Task 5：创建 `packages/cli/src/components/relative-time.ts`（spec §8 已有完整代码），提交 test + impl。
- [ ] 确认 `pnpm build` 全绿。
- [ ] `startup.test.ts` MCP mock 失败：标注既有/环境依赖，不在本计划范围（如需修复另开任务）。

---

## 修订后执行顺序（建议）

```
A (补 Task 5) -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12 -> 13 -> 14(含 Enter 修订) -> B(/diary 切换) -> 15(清理)
```
Task B 在 14 之后（依赖 diaryAccent 与 InputBox 样式）。0–4 已完成，跳过。
