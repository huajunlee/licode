# Context Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the one-shot context compressor to a rolling evolutionary summary plus three-tier selective retention (deterministic must-keep, model soft-judgment, budget cut) with file-change compaction, and show token usage as a percentage in the status bar.

**Architecture:** Extend `ContextCompressor` in-place. Replace the injected `summarizer` callback with a `CompressionAssistant` (one unified side-call that classifies candidate turns, generates file-change descriptors, and merges the rolling summary). Add `git-pointer.ts` (blob-hash recovery pointer with non-git spill fallback) and `file-change.ts` (structured `file_change` note build/parse). Compression shape becomes `[firstUser, SUMMARY, ...mustKeep, ...important, ...recent]` with budget-driven shedding.

**Tech Stack:** TypeScript, Node >=20, pnpm, vitest, ink/React (CLI UI), `@anthropic-ai/sdk`. No new runtime deps (uses built-in `child_process`, `crypto`, `fs`).

## Global Constraints

- Node `>=20`; package manager `pnpm`; test runner `vitest` (`pnpm test` = `vitest run`).
- Build: `pnpm build` (root) = `pnpm -r build`; core build = `tsc`. Zero new runtime dependencies.
- Worktree branch: `worktree-context-management-improvement`. Main branch is `master`; remote is gitee (no `gh`).
- Compression must never break the agent loop: side-call/parse failures degrade to `trim`; best-effort throughout.
- Anthropic Messages API requires alternating user/assistant roles and no orphaned `tool_result` — every compression output must preserve both.
- Existing test helpers in `packages/core/src/context/context.test.ts`: `U(content)`, `A(content)`, `aT(id,name,input)`, `uR(id,content)` build `Message`s; `ts()` for timestamps. Reuse them.
- `Message` union (`packages/core/src/llm/provider.ts`): `SystemMessage | UserMessage | AssistantMessage | ToolUseMessage | ToolResultMessage`. `ToolUseBlock = {id,name,input}`, `ToolResultBlock = {tool_use_id, content, is_error?}`. A user-text message is `role:"user"` with `typeof content === "string"`.
- Working directory in the CLI is `process.cwd()` (see `packages/cli/src/hooks.ts:324,409`).
- `TokenCounter` (`packages/core/src/llm/token-counter.ts`): `new TokenCounter()` (no args); `estimate(text): number`; `estimateMessages(messages): number`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/context/git-pointer.ts` (new) | `getRecoveryPointer(content, workingDirectory)` — git blob hash via `git hash-object -w --stdin`; non-git fallback spills to `.licode/overflow/<sha1>.txt` |
| `packages/core/src/context/file-change.ts` (new) | `file_change` note type, `computeStats`, `buildFileChangeMessage`, `isFileChangeMessage`, `parseFileChangeMessage`, tool-name sets |
| `packages/core/src/context/summarizer.ts` (modify) | Keep `Summarizer`; add `CompressionAssistant` (unified side-call, structured JSON) |
| `packages/core/src/context/compressor.ts` (rewrite) | `classifyMiddleTurns`, `extractExistingSummary`, `isSummaryMessage`, new `compress()` orchestration; config takes `compressionAssistant` + working dir + flags |
| `packages/core/src/events/types.ts` (modify) | Extend `context-compressed` event with `rolling` method + `retainedTurns`/`compactedTurns`/`summaryUpdated` |
| `packages/core/src/agent/loop.ts` (modify) | `ContextConfig` flags + `summaryMaxTokens`; pass `budgetTokens` to `compress()`; emit new event fields |
| `packages/cli/src/hooks.ts` (modify) | `createContextCompressor` builds `CompressionAssistant` + flagged `ContextCompressor` with `process.cwd()`; thread `contextWindow` to UI |
| `packages/cli/src/components/status-bar.tsx` (modify) | Token display as `pct% (usedK/windowK)` |
| `packages/cli/src/app.tsx` (modify) | Pass `contextWindow` to `StatusBar` |
| `packages/core/src/extensions/commands/builtin/context.ts` (modify) | `/context` shows compression/retention stats |
| `packages/core/src/index.ts` (modify) | Export new modules |

---

### Task 1: git-pointer.ts — recovery pointer

**Files:**
- Create: `packages/core/src/context/git-pointer.ts`
- Test: `packages/core/src/context/git-pointer.test.ts`

**Interfaces:**
- Produces: `getRecoveryPointer(content: string, workingDirectory: string): Promise<RecoveryPointer>` where `RecoveryPointer = { version: string; method: "git" | "spill"; spillPath?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRecoveryPointer } from "./git-pointer.js";

describe("getRecoveryPointer", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("spills to .licode/overflow when not a git repo, with a recoverable content hash", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-gp-"));
    const content = "line1\nline2\n";
    const p = await getRecoveryPointer(content, dir);
    expect(p.method).toBe("spill");
    expect(p.spillPath).toBeTruthy();
    const abs = path.join(dir, p.spillPath!);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf-8")).toBe(content);
    // version is the sha1 of the content (40 hex)
    expect(p.version).toMatch(/^[0-9a-f]{40}$/);
  });

  it("uses git blob hash when inside a git repo", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-gp-"));
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: dir });
    const p = await getRecoveryPointer("hello", dir);
    expect(p.method).toBe("git");
    expect(p.version).toMatch(/^[0-9a-f]{40}$/);
    expect(p.spillPath).toBeUndefined();
    // the blob is recoverable via git cat-file
    const out = execSync(`git cat-file -p ${p.version}`, { cwd: dir, encoding: "utf-8" });
    expect(out).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/context/git-pointer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RecoveryPointer {
  version: string;
  method: "git" | "spill";
  /** Relative path to the spilled file, set only when method === "spill". */
  spillPath?: string;
}

/**
 * Produce a recoverable pointer for `content`:
 * - In a git repo: `git hash-object -w --stdin` stores the blob and returns its
 *   hash (no commit). Recover via `git cat-file -p <hash>`.
 * - Otherwise: spill the content to `.licode/overflow/<sha1>.txt` and return the
 *   sha1 + relative path. Recover via `read` on the spill path.
 */
export async function getRecoveryPointer(
  content: string,
  workingDirectory: string
): Promise<RecoveryPointer> {
  try {
    const hash = execSync("git hash-object -w --stdin", {
      cwd: workingDirectory,
      input: content,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(hash)) {
      return { version: hash, method: "git" };
    }
  } catch {
    // not a git repo or git unavailable -> fall through to spill
  }
  const hash = crypto.createHash("sha1").update(content, "utf-8").digest("hex");
  const overflowDir = path.join(workingDirectory, ".licode", "overflow");
  await fs.promises.mkdir(overflowDir, { recursive: true });
  const filePath = path.join(overflowDir, `${hash}.txt`);
  await fs.promises.writeFile(filePath, content, "utf-8");
  return { version: hash, method: "spill", spillPath: path.relative(workingDirectory, filePath) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/context/git-pointer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context/git-pointer.ts packages/core/src/context/git-pointer.test.ts
git commit -m "feat(context): add recovery pointer (git blob hash + spill fallback)"
```

---

### Task 2: file-change.ts — structured write-turn note

**Files:**
- Create: `packages/core/src/context/file-change.ts`
- Test: `packages/core/src/context/file-change.test.ts`

**Interfaces:**
- Produces: `FileChangeNote`, `FileChangeOperation`, `FileChangeStats`, `FILE_CHANGE_PREFIX`, `WRITE_TOOL_NAMES`, `EDIT_TOOL_NAMES`, `lineCount`, `computeStats`, `buildFileChangeMessage`, `isFileChangeMessage`, `parseFileChangeMessage`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/context/file-change.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/context/file-change.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context/file-change.ts packages/core/src/context/file-change.test.ts
git commit -m "feat(context): add file_change note build/parse for write-turn compaction"
```

---

### Task 3: CompressionAssistant — unified side-call

**Files:**
- Modify: `packages/core/src/context/summarizer.ts` (append `CompressionAssistant`; keep existing `Summarizer`)
- Test: `packages/core/src/context/compression-assistant.test.ts`

**Interfaces:**
- Consumes: `FileChangeStats` from `./file-change.js`.
- Produces: `CompressionTurnInput`, `CompressionClassification`, `CompressionFileChange`, `CompressionAssistResult`, `CompressionAssistantConfig`, `class CompressionAssistant`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CompressionAssistant } from "./summarizer.js";

describe("CompressionAssistant", () => {
  it("parses a JSON response into structured result", async () => {
    const canned = JSON.stringify({
      updatedSummary: "user worked on auth",
      classifications: [{ index: 1, keep: "important" }],
      fileChanges: [{ index: 2, symbols: ["JwtFilter.doFilter"], summary: { kind: "add filter" } }],
    });
    const a = new CompressionAssistant({ generate: async () => canned });
    const res = await a.assist({
      existingSummary: null,
      turns: [
        { index: 1, kind: "candidate", text: "user: lets use jwt" },
        { index: 2, kind: "must-keep-write", text: "write src/JwtFilter.java", writeOperation: "write", writePath: "src/JwtFilter.java", writeStats: { added: 35, removed: 0 } },
      ],
    });
    expect(res.updatedSummary).toBe("user worked on auth");
    expect(res.classifications).toEqual([{ index: 1, keep: "important" }]);
    expect(res.fileChanges[0].symbols).toEqual(["JwtFilter.doFilter"]);
  });

  it("passes existing summary into the prompt (rolling)", async () => {
    let seen = "";
    const a = new CompressionAssistant({ generate: async (p) => { seen = p; return '{"updatedSummary":"s","classifications":[],"fileChanges":[]}'; } });
    await a.assist({ existingSummary: "PRIOR", turns: [] });
    expect(seen).toContain("PRIOR");
  });

  it("throws on non-JSON response (compressor will degrade to trim)", async () => {
    const a = new CompressionAssistant({ generate: async () => "nope not json" });
    await expect(a.assist({ existingSummary: null, turns: [] })).rejects.toThrow();
  });

  it("strips markdown fences around the JSON", async () => {
    const fenced = "```json\n" + JSON.stringify({ updatedSummary: "s", classifications: [], fileChanges: [] }) + "\n```";
    const a = new CompressionAssistant({ generate: async () => fenced });
    const res = await a.assist({ existingSummary: null, turns: [] });
    expect(res.updatedSummary).toBe("s");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/context/compression-assistant.test.ts`
Expected: FAIL — `CompressionAssistant` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/context/summarizer.ts` (keep the existing `Summarizer` class and its imports; add an import for `FileChangeStats`):

```ts
import type { FileChangeStats } from "./file-change.js";

export interface CompressionTurnInput {
  index: number;
  kind: "must-keep-error" | "must-keep-write" | "candidate" | "fold";
  text: string;
  writeOperation?: "write" | "edit";
  writePath?: string;
  writeStats?: FileChangeStats;
}

export interface CompressionClassification {
  index: number;
  keep: "important" | "normal";
}

export interface CompressionFileChange {
  index: number;
  symbols: string[];
  summary: { kind: string };
}

export interface CompressionAssistResult {
  updatedSummary: string;
  classifications: CompressionClassification[];
  fileChanges: CompressionFileChange[];
}

export interface CompressionAssistantConfig {
  generate: (prompt: string) => Promise<string>;
  summaryMaxTokens?: number;
}

export class CompressionAssistant {
  constructor(private config: CompressionAssistantConfig) {}

  async assist(input: {
    existingSummary: string | null;
    turns: CompressionTurnInput[];
  }): Promise<CompressionAssistResult> {
    const maxTokens = this.config.summaryMaxTokens ?? 2048;
    const prompt = this.buildPrompt(input.existingSummary, input.turns, maxTokens);
    const raw = await this.config.generate(prompt);
    return this.parse(raw);
  }

  private buildPrompt(
    existingSummary: string | null,
    turns: CompressionTurnInput[],
    maxTokens: number
  ): string {
    const lines: string[] = [];
    lines.push("You are a context-compression assistant. Update the rolling summary and classify older turns.");
    lines.push(`Keep updatedSummary under ${maxTokens} tokens; drop the oldest/least-important details if needed.`);
    lines.push("");
    lines.push("Existing summary:");
    lines.push(existingSummary ?? "(none)");
    lines.push("");
    lines.push("Turns:");
    for (const t of turns) {
      let label = `[${t.index}] (${t.kind})`;
      if (t.kind === "must-keep-write" && t.writeOperation) {
        label += ` ${t.writeOperation} ${t.writePath} +${t.writeStats?.added ?? 0}/-${t.writeStats?.removed ?? 0}`;
      }
      lines.push(`${label}: ${t.text}`);
    }
    lines.push("");
    lines.push('Respond with ONLY a JSON object:');
    lines.push('{"updatedSummary":"...","classifications":[{"index":N,"keep":"important"|"normal"}],"fileChanges":[{"index":N,"symbols":["..."],"summary":{"kind":"..."}}]}');
    lines.push("");
    lines.push("Rules:");
    lines.push('- Fold "fold" and "normal" candidate turns into updatedSummary.');
    lines.push('- For each "candidate" turn, set keep "important" (keep verbatim) or "normal" (fold).');
    lines.push('- For each "must-keep-write" turn, produce a fileChanges entry: new core symbols + a one-line intent.');
    lines.push('- For "important" and must-keep turns, add only a brief reference in updatedSummary.');
    return lines.join("\n");
  }

  private parse(raw: string): CompressionAssistResult {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object in compression response");
    }
    let obj: unknown;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      throw new Error(`invalid JSON in compression response: ${(e as Error).message}`);
    }
    const o = obj as Record<string, unknown>;
    if (typeof o.updatedSummary !== "string") {
      throw new Error("compression response missing updatedSummary string");
    }
    const classifications: CompressionClassification[] = Array.isArray(o.classifications)
      ? (o.classifications as Record<string, unknown>[]).map((c) => ({
          index: Number(c.index),
          keep: c.keep === "important" ? "important" : "normal",
        }))
      : [];
    const fileChanges: CompressionFileChange[] = Array.isArray(o.fileChanges)
      ? (o.fileChanges as Record<string, unknown>[]).map((f) => ({
          index: Number(f.index),
          symbols: Array.isArray(f.symbols) ? f.symbols.map(String) : [],
          summary: { kind: String((f.summary as Record<string, unknown> | undefined)?.kind ?? "") },
        }))
      : [];
    return { updatedSummary: o.updatedSummary, classifications, fileChanges };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/context/compression-assistant.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context/summarizer.ts packages/core/src/context/compression-assistant.test.ts
git commit -m "feat(context): add CompressionAssistant unified side-call"
```

---

### Task 4: Extend context-compressed event type

**Files:**
- Modify: `packages/core/src/events/types.ts:13-17`

**Interfaces:**
- Produces: extended `context-compressed` event variant (adds `"rolling"` method + `retainedTurns?`, `compactedTurns?`, `summaryUpdated?`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
// Type-level test: the new fields must be assignable.
import type { PipelineEvent } from "./types.js";

describe("context-compressed event", () => {
  it("accepts rolling method and new stat fields", () => {
    const e: PipelineEvent = {
      type: "context-compressed",
      method: "rolling",
      removedMessages: 4,
      retainedTurns: 2,
      compactedTurns: 1,
      summaryUpdated: true,
    };
    expect(e.type).toBe("context-compressed");
    expect(e.method).toBe("rolling");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/events/types.test.ts`
Expected: FAIL — TS error: `"rolling"` not assignable to `"trim" | "summarize"`, and unknown fields.

- [ ] **Step 3: Write minimal implementation**

Replace the `context-compressed` variant in `packages/core/src/events/types.ts` (lines 13-17) with:

```ts
  | {
      type: "context-compressed";
      method: "trim" | "summarize" | "rolling";
      removedMessages?: number;
      retainedTurns?: number;
      compactedTurns?: number;
      summaryUpdated?: boolean;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/events/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/types.ts packages/core/src/events/types.test.ts
git commit -m "feat(context): extend context-compressed event with rolling + retention stats"
```

---

### Task 5: Compressor helpers — summary detection + turn classification

**Files:**
- Modify: `packages/core/src/context/compressor.ts` (add exported helpers; do not yet rewrite `compress()`)
- Test: `packages/core/src/context/compressor-helpers.test.ts`

**Interfaces:**
- Consumes: `isFileChangeMessage`, `WRITE_TOOL_NAMES`, `EDIT_TOOL_NAMES` from `./file-change.js`; `Message`, `ToolUseBlock`, `ToolResultBlock` from `../llm/provider.js`.
- Produces: `SUMMARY_PREFIX`, `isSummaryMessage`, `extractExistingSummary`, `ClassifiedTurn`, `classifyMiddleTurns`. (The existing `splitIntoTurns`, `isUserTextMessage`, `ContextCompressor`, `CompressionResult` stay.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { Message } from "../llm/provider.js";
import {
  SUMMARY_PREFIX,
  isSummaryMessage,
  extractExistingSummary,
  classifyMiddleTurns,
} from "./compressor.js";

const ts = () => new Date().toISOString();
const U = (c: string): Message => ({ role: "user", content: c, timestamp: ts() });
const A = (c: string): Message => ({ role: "assistant", content: c, timestamp: ts() });
const aT = (id: string, name: string, input: Record<string, unknown>): Message => ({
  role: "assistant", content: [{ id, name, input }], timestamp: ts(),
});
const uR = (id: string, content: string, isError = false): Message => ({
  role: "user", content: [{ tool_use_id: id, content, is_error: isError }], timestamp: ts(),
});

describe("summary detection", () => {
  it("detects and extracts the existing rolling summary text", () => {
    const msg: Message = { role: "assistant", content: `${SUMMARY_PREFIX}prior work`, timestamp: ts() };
    expect(isSummaryMessage(msg)).toBe(true);
    expect(isSummaryMessage(A("not a summary"))).toBe(false);
    expect(extractExistingSummary([U("x"), msg, A("y")])).toBe("prior work");
    expect(extractExistingSummary([U("x"), A("y")])).toBeNull();
  });
});

describe("classifyMiddleTurns", () => {
  it("marks error turns must-keep-error, write turns must-keep-write, others candidate", () => {
    const turns = [
      [U("t1"), aT("e1", "read", {}), uR("e1", "boom", true), A("recovered")], // error
      [U("t2"), aT("w1", "Write", { file_path: "a.ts", content: "x" }), uR("w1", "ok")], // write
      [U("t3"), A("plain")], // candidate
    ];
    const c = classifyMiddleTurns(turns, { selectiveRetention: true });
    expect(c[0].kind).toBe("must-keep-error");
    expect(c[1].kind).toBe("must-keep-write");
    expect(c[1].alreadyCompacted).toBe(false);
    expect(c[2].kind).toBe("candidate");
    expect(c.every((x) => x.complete)).toBe(true);
  });

  it("treats turns not starting with a user-text message as fold (orphan run-0 tail)", () => {
    const c = classifyMiddleTurns([[A("orphan")]], { selectiveRetention: true });
    expect(c[0].kind).toBe("fold");
    expect(c[0].complete).toBe(false);
  });

  it("with selectiveRetention off, everything is a candidate", () => {
    const turns = [[U("t1"), aT("w1", "Write", { file_path: "a", content: "x" }), uR("w1", "ok")]];
    const c = classifyMiddleTurns(turns, { selectiveRetention: false });
    expect(c[0].kind).toBe("candidate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/context/compressor-helpers.test.ts`
Expected: FAIL — `SUMMARY_PREFIX`/`classifyMiddleTurns` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/core/src/context/compressor.ts` (add imports at top: `ToolUseBlock, ToolResultBlock` from `../llm/provider.js`; `isFileChangeMessage, WRITE_TOOL_NAMES, EDIT_TOOL_NAMES` from `./file-change.js`). Append the helpers (leave the existing `splitIntoTurns`, `isUserTextMessage`, `ContextCompressor` in place for now):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/core/src/context/compressor-helpers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context/compressor.ts packages/core/src/context/compressor-helpers.test.ts
git commit -m "feat(context): add summary detection + middle-turn classification helpers"
```

---

### Task 6: Compressor compress() rewrite — rolling + selective retention

**Files:**
- Rewrite: `packages/core/src/context/compressor.ts` (`ContextCompressor` class + `ContextCompressorConfig` + `CompressionResult`)
- Rewrite tests: `packages/core/src/context/context.test.ts` (the `ContextCompressor` describe block; keep `splitIntoTurns` tests as-is)

**Interfaces:**
- Consumes: `CompressionAssistant`/`CompressionAssistResult`/`CompressionTurnInput` from `./summarizer.js`; `getRecoveryPointer` from `./git-pointer.js`; `computeStats`, `buildFileChangeMessage`, `isFileChangeMessage`, `WRITE_TOOL_NAMES`, `EDIT_TOOL_NAMES`, `FileChangeNote`, `FileChangeOperation` from `./file-change.js`; `TokenCounter` from `../llm/token-counter.js`; helpers from Task 5.
- Produces: `ContextCompressorConfig { compressionAssistant; workingDirectory; rollingSummary?; selectiveRetention?; fileChangeCompaction?; summaryMaxTokens? }`; `CompressOptions { keepRecentTurns; budgetTokens? }`; updated `CompressionResult { compressed; removedMessages; summary?; method?; retainedTurns?; compactedTurns?; summaryUpdated? }`; `class ContextCompressor { compress(conversation, opts) }`.

- [ ] **Step 1: Write the failing tests**

Replace the `describe("ContextCompressor", ...)` block in `packages/core/src/context/context.test.ts` with the new tests below (keep the `describe("splitIntoTurns", ...)` and `describe("TokenBudget", ...)` blocks unchanged). Add imports at the top of the file:

```ts
import type { CompressionAssistResult } from "./summarizer.js";
import { FILE_CHANGE_PREFIX } from "./file-change.js";

/** A duck-typed CompressionAssistant that returns a canned result. */
function fakeAssistant(over: Partial<CompressionAssistResult> = {}): {
  assist: (input: { existingSummary: string | null; turns: unknown[] }) => Promise<CompressionAssistResult>;
} {
  return {
    async assist(input) {
      return {
        updatedSummary: over.updatedSummary ?? `SUMMARY(${input.existingSummary ? "roll" : "new"})`,
        classifications: over.classifications ?? [],
        fileChanges: over.fileChanges ?? [],
      };
    },
  };
}
```

New `ContextCompressor` tests:

```ts
describe("ContextCompressor (Phase 5)", () => {
  it("keeps firstUser + rolling SUMMARY + recent; folds the middle", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([
      U("turn1"), A("a1"),
      U("turn2"), A("a2"),
      U("turn3"), A("a3"),
      U("turn4"), A("a4"),
    ]);
    const compressor = new ContextCompressor({
      compressionAssistant: fakeAssistant({ updatedSummary: "rolled" }),
      workingDirectory: process.cwd(),
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });

    expect(result.compressed).toBe(true);
    expect(result.method).toBe("summarize"); // first compression, no prior summary
    expect(result.summaryUpdated).toBe(true);
    const out = mgr.getMessages();
    expect(out[0]).toMatchObject({ role: "user", content: "turn1" });
    expect(out[1]).toMatchObject({ role: "assistant", content: "Previous conversation summary: rolled" });
    expect(out.at(-1)).toMatchObject({ role: "assistant", content: "a4" });
    const roles = out.map((m) => m.role);
    // user, assistant, user, assistant, user, assistant
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("second compression is rolling (existing summary passed to the assistant)", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([
      U("t1"), A("a1"),
      U("t2"), A("a2"),
      U("t3"), A("a3"),
      U("t4"), A("a4"),
    ]);
    const seen: (string | null)[] = [];
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: {
        async assist(input) {
          seen.push(input.existingSummary);
          return { updatedSummary: "S2", classifications: [], fileChanges: [] };
        },
      } as never,
    });
    await compressor.compress(mgr, { keepRecentTurns: 1 });
    // add more turns, compress again -> existing summary present
    mgr.replaceMessages([...mgr.getMessages(), U("t5"), A("a5"), U("t6"), A("a6")]);
    const r2 = await compressor.compress(mgr, { keepRecentTurns: 1 });
    expect(seen[1]).toBe("S2"); // prior summary fed back in
    expect(r2.method).toBe("rolling");
  });

  it("retains must-keep error + write turns; compacts write into a file_change note", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "licode-p5-"));
    try {
      const mgr = new ConversationManager({ model: "m" });
      mgr.replaceMessages([
        U("t1"), A("a1"),
        U("t2"), aT("e1", "Bash", {}), uR("e1", "boom", true), A("fixed"),
        U("t3"), aT("w1", "Write", { file_path: "a.txt", content: "hello\nworld" }), uR("w1", "ok"),
        U("t4"), A("a4"),
      ]);
      const compressor = new ContextCompressor({
        workingDirectory: dir,
        compressionAssistant: fakeAssistant({
          fileChanges: [{ index: 2, symbols: ["greet"], summary: { kind: "add greeting" } }],
        }),
      });
      const result = await compressor.compress(mgr, { keepRecentTurns: 1 });
      const out = mgr.getMessages();
      // error turn retained verbatim
      expect(out.some((m) => m.role === "user" && Array.isArray(m.content) &&
        (m.content as { tool_use_id: string }[]).some((b) => b.tool_use_id === "e1"))).toBe(true);
      // write turn compacted to a file_change note (no raw tool_use 'w1' remains)
      expect(out.some((m) => m.role === "assistant" && Array.isArray(m.content) &&
        (m.content as { id: string }[]).some((b) => b.id === "w1"))).toBe(false);
      expect(out.some((m) => typeof m.content === "string" && m.content.startsWith(FILE_CHANGE_PREFIX))).toBe(true);
      expect(result.compactedTurns).toBe(1);
      expect(result.retainedTurns).toBeGreaterThanOrEqual(2); // error + recent at least
      // no orphan tool_result
      for (const m of out) {
        if (m.role === "user" && Array.isArray(m.content)) {
          for (const b of m.content as { tool_use_id: string }[]) {
            expect(out.some((mm) => mm.role === "assistant" && Array.isArray(mm.content) &&
              (mm.content as { id: string }[]).some((x) => x.id === b.tool_use_id))).toBe(true);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps important candidate turns when budget allows; sheds them when over budget", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([
      U("t1"), A("a1"),
      U("t2 important"), A("a2"),
      U("t3"), A("a3"),
      U("t4"), A("a4"),
    ]);
    const important = [{ index: 1, keep: "important" as const }];
    // budget large -> important retained
    const cBig = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: fakeAssistant({ classifications: important }),
    });
    await cBig.compress(mgr, { keepRecentTurns: 1, budgetTokens: 1_000_000 });
    expect(mgr.getMessages().some((m) => m.role === "user" && m.content === "t2 important")).toBe(true);

    // reset and compress with tiny budget -> important shed (folded; only in summary)
    mgr.replaceMessages([
      U("t1"), A("a1"),
      U("t2 important"), A("a2"),
      U("t3"), A("a3"),
      U("t4"), A("a4"),
    ]);
    const cSmall = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: fakeAssistant({ classifications: important }),
    });
    await cSmall.compress(mgr, { keepRecentTurns: 1, budgetTokens: 1 });
    expect(mgr.getMessages().some((m) => m.role === "user" && m.content === "t2 important")).toBe(false);
  });

  it("degrades to trim when the assistant throws", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([U("t1"), A("a1"), U("t2"), A("a2"), U("t3"), A("a3")]);
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: { async assist() { throw new Error("down"); } } as never,
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });
    expect(result.compressed).toBe(true);
    expect(result.method).toBe("trim");
    expect(result.summaryUpdated).toBe(false);
    const out = mgr.getMessages();
    expect(out[0]).toMatchObject({ role: "user" });
    expect(out[0].content as string).toContain("Earlier task");
  });

  it("does not compress when there are not enough turns", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.replaceMessages([U("only"), A("ans")]);
    const compressor = new ContextCompressor({
      workingDirectory: process.cwd(),
      compressionAssistant: fakeAssistant(),
    });
    const result = await compressor.compress(mgr, { keepRecentTurns: 2 });
    expect(result.compressed).toBe(false);
    expect(mgr.getMessages()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test packages/core/src/context/context.test.ts`
Expected: FAIL — `ContextCompressor` constructor no longer accepts `summarizer`; new behavior absent.

- [ ] **Step 3: Write minimal implementation**

Replace the `ContextCompressorConfig`, `CompressionResult`, and `ContextCompressor` class in `packages/core/src/context/compressor.ts` with the version below. Keep `splitIntoTurns`, `isUserTextMessage`, and the Task-5 helpers unchanged. Ensure the top of the file imports:

```ts
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
```

New config + class:

```ts
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

    const turnInputs: CompressionTurnInput[] = classified.map((c, i) => {
      const base: CompressionTurnInput = { index: i + 1, kind: c.kind, text: turnText(c.turn) };
      if (c.kind === "must-keep-write" && !c.alreadyCompacted) {
        const use = findWriteToolUse(c.turn);
        if (use) {
          const operation: FileChangeOperation = WRITE_TOOL_NAMES.has(use.name) ? "write" : "edit";
          base.writeOperation = operation;
          base.writePath = String(use.input.file_path ?? "");
          base.writeStats = computeStats(operation, use.input);
        }
      }
      return base;
    });

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

    for (let i = 0; i < classified.length; i++) {
      const c = classified[i];
      const idx = i + 1;
      if (c.kind === "fold") continue; // always folded into summary
      if (c.kind === "must-keep-error") {
        retainedMiddle.push(...c.turn);
        retainedCount++;
        continue;
      }
      if (c.kind === "must-keep-write") {
        if (c.alreadyCompacted || !this.fileChangeCompaction) {
          retainedMiddle.push(...c.turn);
        } else {
          const note = await this.buildNote(c.turn, fileChangeByIndex.get(idx));
          // turn = [userText, assistant(tool_use), user(tool_result), ...] -> [userText, note]
          retainedMiddle.push(c.turn[0], note);
          compactedTurns++;
        }
        retainedCount++;
        continue;
      }
      // candidate
      const keep = classByIndex.get(idx) ?? "normal";
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test packages/core/src/context/context.test.ts packages/core/src/context/compressor-helpers.test.ts`
Expected: PASS (all Phase 5 compressor + helper tests, plus the unchanged `splitIntoTurns`/`TokenBudget` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context/compressor.ts packages/core/src/context/context.test.ts
git commit -m "feat(context): rolling summary + three-tier selective retention in compress()"
```

---

### Task 7: AgentLoop wiring — ContextConfig flags + budgetTokens + event fields

**Files:**
- Modify: `packages/core/src/agent/loop.ts` (`ContextConfig` interface, constructor defaults, the compression block at ~line 121-138)
- Test: `packages/core/src/agent/loop.test.ts` (add a test that `compress()` receives `budgetTokens`)

**Interfaces:**
- Consumes: `CompressOptions` from `../context/compressor.js`; extended `context-compressed` event from Task 4.
- Produces: `ContextConfig` gains `summaryMaxTokens?`, `rollingSummary?`, `selectiveRetention?`, `fileChangeCompaction?`, `importantTurnsBudget?`. `compress()` is called with `{ keepRecentTurns, budgetTokens }`. Emitted event includes `retainedTurns`/`compactedTurns`/`summaryUpdated`.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/agent/loop.test.ts`, add (adjust existing imports as needed):

```ts
import type { CompressionResult } from "../context/compressor.js";

it("passes budgetTokens to compress() and emits rolling retention stats", async () => {
  // Build a loop with a fake compressor that records opts and returns a rolling result.
  // (Reuse the existing loop.test.ts harness for constructing AgentLoop; if a helper
  //  exists, use it. Otherwise construct AgentLoop directly with a mock LLMProvider.)
  const seen: Record<string, unknown> = {};
  const fakeCompressor = {
    async compress(_conv: unknown, opts: { keepRecentTurns: number; budgetTokens?: number }): Promise<CompressionResult> {
      seen.keepRecentTurns = opts.keepRecentTurns;
      seen.budgetTokens = opts.budgetTokens;
      return {
        compressed: true,
        removedMessages: 3,
        method: "rolling",
        retainedTurns: 2,
        compactedTurns: 1,
        summaryUpdated: true,
      };
    },
  };
  // ... construct AgentLoop with a provider whose maxContextTokens is tiny so the
  // threshold trips immediately, call run(), and assert seen.budgetTokens is a number
  // and that a "context-compressed" event with method "rolling" was emitted.
  // NOTE: mirror the existing loop.test.ts pattern for provider/EventBus mocking.
  expect(seen.budgetTokens).toBeGreaterThan(0);
});
```

> If `loop.test.ts` already has a helper that builds a loop with a mock provider and a capturing `EventBus`, reuse it. The assertion that matters: `compress()` receives a numeric `budgetTokens`, and the emitted `context-compressed` event carries `method: "rolling"` + the retention fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/agent/loop.test.ts`
Expected: FAIL — `budgetTokens` not passed (undefined) and/or new event fields absent.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/agent/loop.ts`:

(a) Extend `ContextConfig` (add after `overflowMaxBytes`):

```ts
  /** Max tokens for the rolling summary. Default 2048. (Phase 5) */
  summaryMaxTokens?: number;
  /** Soft budget fraction (0-1) for should-keep turns. Optional. (Phase 5) */
  importantTurnsBudget?: number;
  /** Phase 5 toggles (default all true). */
  rollingSummary?: boolean;
  selectiveRetention?: boolean;
  fileChangeCompaction?: boolean;
```

(b) In the constructor defaults object (where `overflowMaxBytes` is set), add:

```ts
      summaryMaxTokens: config.context?.summaryMaxTokens ?? 2048,
      rollingSummary: config.context?.rollingSummary ?? true,
      selectiveRetention: config.context?.selectiveRetention ?? true,
      fileChangeCompaction: config.context?.fileChangeCompaction ?? true,
```

(The `Required<ContextConfig>` type now includes these. `importantTurnsBudget` is optional — keep it out of `Required` or default it to `undefined`; simplest is to read it directly from `config.context?.importantTurnsBudget` where needed. To avoid `Required` friction, declare `importantTurnsBudget?` and do not add it to the defaults object; read it lazily.)

(c) Replace the compression block (the `if (!compressedThisRun && this.compressor && ...) { ... }`) with:

```ts
        if (
          !compressedThisRun &&
          this.compressor &&
          this.conversation.getTokenCount() >
            this.context.compressThreshold * this.llm.maxContextTokens
        ) {
          const result = await this.compressor.compress(this.conversation, {
            keepRecentTurns: this.context.keepRecentTurns,
            budgetTokens: Math.round(
              this.context.compressThreshold * this.llm.maxContextTokens
            ),
          });
          if (result.compressed) {
            this.eventBus?.emit({
              type: "context-compressed",
              method: result.method ?? "summarize",
              removedMessages: result.removedMessages,
              retainedTurns: result.retainedTurns,
              compactedTurns: result.compactedTurns,
              summaryUpdated: result.summaryUpdated,
            });
          }
          compressedThisRun = true;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test packages/core/src/agent/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/loop.ts packages/core/src/agent/loop.test.ts
git commit -m "feat(context): wire budgetTokens + Phase 5 flags + retention event fields into loop"
```

---

### Task 8: CLI createContextCompressor — build CompressionAssistant + flagged compressor

**Files:**
- Modify: `packages/cli/src/hooks.ts` (`createContextCompressor` ~line 89-110; the call site ~line 290)

**Interfaces:**
- Consumes: `CompressionAssistant` from `@licode/core` (or relative import), `ContextCompressor` with the new config, env vars `LICODE_CONTEXT_ROLLING`, `LICODE_CONTEXT_SELECTIVE`, `LICODE_CONTEXT_FILECHANGE`, `LICODE_CONTEXT_SUMMARY_MAX_TOKENS`.

- [ ] **Step 1: Write the failing test**

This is wiring code with a real provider; test the flag-reading helper in isolation. Add to a new `packages/cli/src/hooks.compressor.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// Extract the flag-reading into a pure helper so it is testable.
import { readContextFlags } from "./hooks.js";

describe("readContextFlags", () => {
  it("defaults all flags on", () => {
    const prev = { ...process.env };
    delete process.env.LICODE_CONTEXT_ROLLING;
    delete process.env.LICODE_CONTEXT_SELECTIVE;
    delete process.env.LICODE_CONTEXT_FILECHANGE;
    const f = readContextFlags();
    expect(f).toEqual({ rollingSummary: true, selectiveRetention: true, fileChangeCompaction: true, summaryMaxTokens: 2048 });
    process.env = prev;
  });

  it("turns a flag off when set to 'off'", () => {
    const prev = { ...process.env };
    process.env.LICODE_CONTEXT_ROLLING = "off";
    const f = readContextFlags();
    expect(f.rollingSummary).toBe(false);
    expect(f.selectiveRetention).toBe(true);
    process.env = prev;
  });

  it("honors a custom summary max tokens", () => {
    const prev = { ...process.env };
    process.env.LICODE_CONTEXT_SUMMARY_MAX_TOKENS = "1024";
    expect(readContextFlags().summaryMaxTokens).toBe(1024);
    process.env = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/hooks.compressor.test.ts`
Expected: FAIL — `readContextFlags` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/hooks.ts`:

(a) Update imports (add `CompressionAssistant` alongside the existing `ContextCompressor`/`Summarizer` imports from core):

```ts
import { ContextCompressor, CompressionAssistant } from "@licode/core";
```

(If the existing import uses a relative path to `packages/core`, match that style.)

(b) Add the pure helper and rewrite `createContextCompressor`:

```ts
export function readContextFlags(): {
  rollingSummary: boolean;
  selectiveRetention: boolean;
  fileChangeCompaction: boolean;
  summaryMaxTokens: number;
} {
  const off = (v?: string) => v === "off";
  return {
    rollingSummary: !off(process.env.LICODE_CONTEXT_ROLLING),
    selectiveRetention: !off(process.env.LICODE_CONTEXT_SELECTIVE),
    fileChangeCompaction: !off(process.env.LICODE_CONTEXT_FILECHANGE),
    summaryMaxTokens: Number(process.env.LICODE_CONTEXT_SUMMARY_MAX_TOKENS) || 2048,
  };
}

function createContextCompressor(
  apiKey: string,
  baseUrl: string | undefined,
  model: string,
  workingDirectory: string
): ContextCompressor {
  const flags = readContextFlags();
  const sideProvider = new AnthropicProvider({ apiKey, baseUrl });
  const assistant = new CompressionAssistant({
    generate: async (prompt) => {
      const res = await sideProvider.chat({
        messages: [
          { role: "user", content: prompt, timestamp: new Date().toISOString() },
        ],
        model,
        maxTokens: 2048,
      });
      return res.content;
    },
    summaryMaxTokens: flags.summaryMaxTokens,
  });
  return new ContextCompressor({
    compressionAssistant: assistant,
    workingDirectory,
    rollingSummary: flags.rollingSummary,
    selectiveRetention: flags.selectiveRetention,
    fileChangeCompaction: flags.fileChangeCompaction,
    summaryMaxTokens: flags.summaryMaxTokens,
  });
}
```

(c) Update the call site (≈ line 290) to pass the working directory:

```ts
    compressorRef.current = createContextCompressor(apiKey, baseUrl, model, process.cwd());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test packages/cli/src/hooks.compressor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/hooks.ts packages/cli/src/hooks.compressor.test.ts
git commit -m "feat(cli): build CompressionAssistant + flagged compressor from env"
```

---

### Task 9: Status bar percentage display

**Files:**
- Modify: `packages/cli/src/components/status-bar.tsx`
- Modify: `packages/cli/src/hooks.ts` (add `contextWindow` state + thread to result)
- Modify: `packages/cli/src/app.tsx` (pass `contextWindow` to `StatusBar`)
- Test: `packages/cli/src/components/status-bar.test.tsx`

**Interfaces:**
- Produces: `StatusBar` props gain `contextWindow: number`. `UseConversationResult` gains `contextWindow: number`.

- [ ] **Step 1: Write the failing test**

```tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar } from "./status-bar.js";

describe("StatusBar token display", () => {
  it("shows percentage + absolute when contextWindow is known", () => {
    const { lastFrame } = render(
      <StatusBar model="m" tokens={24600} contextWindow={200000} sessionId="abcdefgh" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/12%/);
    expect(frame).toMatch(/24\.6k/);
    expect(frame).toMatch(/200k/);
  });

  it("shows only absolute tokens before the window is published (0)", () => {
    const { lastFrame } = render(
      <StatusBar model="m" tokens={500} contextWindow={0} sessionId="abcdefgh" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/%/);
    expect(frame).toMatch(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/components/status-bar.test.tsx`
Expected: FAIL — `contextWindow` prop unknown; no percentage rendered.

- [ ] **Step 3: Write minimal implementation**

(a) `packages/cli/src/components/status-bar.tsx` — replace `formatTokens` and the props/token display:

```tsx
interface StatusBarProps {
  model: string;
  tokens: number;
  contextWindow: number;
  sessionId: string;
}

function formatK(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

function tokenDisplay(tokens: number, contextWindow: number): string {
  if (contextWindow > 0) {
    const pct = Math.round((tokens / contextWindow) * 100);
    return `${pct}% (${formatK(tokens)}/${formatK(contextWindow)})`;
  }
  return formatK(tokens);
}

export function StatusBar({ model, tokens, contextWindow, sessionId }: StatusBarProps) {
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  const tokenStr = tokenDisplay(tokens, contextWindow);
  return (
    <Box
      flexDirection="column"
      marginTop={SPACING.sm}
      borderStyle={BORDERS.popup}
      paddingX={SPACING.sm}
    >
      <Box flexDirection="row" gap={SPACING.md}>
        <Text>
          <Text dimColor>model: </Text>
          <Text bold>{model}</Text>
        </Text>
        <Text dimColor>│</Text>
        <Text>
          <Text dimColor>tokens: </Text>
          <Text>{tokenStr}</Text>
        </Text>
        <Text dimColor>│</Text>
        <Text>
          <Text dimColor>session: </Text>
          <Text dimColor>{shortId}</Text>
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          Ctrl+Q 返回{"  "}│{"  "}
          <Text color={COLORS.info}>Ctrl+↑↓</Text> 推理{"  "}│{"  "}
          Enter 收起
        </Text>
      </Box>
    </Box>
  );
}
```

(b) `packages/cli/src/hooks.ts` — add a `contextWindow` state, a getter, refresh it in `createEventBus` next to `setTokenCount`, and expose it on `UseConversationResult`:

In `useConversation`, near the other `useState` calls:

```ts
  const [contextWindow, setContextWindow] = useState(0);
```

Add a getter and pass `setContextWindow` into `createEventBus` at both call sites (≈ lines 431, 490). The `createEventBus` signature gains `setContextWindow: (n: number) => void` and `getContextWindow: () => number`. In the `agent-loop-complete` and `context-compressed` cases, after `setTokenCount(getTokenCount())`, add:

```ts
          setContextWindow(getContextWindow());
```

Read it from the manager's budget info: at the call sites pass `getContextWindow: () => manager.getBudgetInfo().contextWindow`.

Add to the returned object (near `tokenCount`):

```ts
    contextWindow,
```

(c) `packages/cli/src/app.tsx` — destructure `contextWindow` from `useConversation(...)` and pass it:

```tsx
      <StatusBar
        model={model ?? "deepseek-v4-pro"}
        tokens={tokenCount}
        contextWindow={contextWindow}
        sessionId={currentSessionId}
      />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test packages/cli/src/components/status-bar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/status-bar.tsx packages/cli/src/components/status-bar.test.tsx packages/cli/src/hooks.ts packages/cli/src/app.tsx
git commit -m "feat(cli): show token usage as percentage + absolute in status bar"
```

---

### Task 10: /context stats, core exports, full build + acceptance

**Files:**
- Modify: `packages/core/src/extensions/commands/builtin/context.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/extensions/commands/builtin/context.test.ts` (add/extend)

**Interfaces:**
- Consumes: `ConversationManager.getBudgetInfo()` (already present), session-level compression stats (track via a counter on the conversation or emit-side; simplest: read `getMessageCount` + budget).
- Produces: `/context` prints compression/retention stats; core exports `getRecoveryPointer`, `CompressionAssistant`, `file-change` helpers, `classifyMiddleTurns`, etc.

- [ ] **Step 1: Write the failing test**

Extend the existing `/context` command test (or create `context-command.test.ts`) to assert the new fields appear. The command reads `conv.getBudgetInfo()` and `conv.getMessageCount()`. Add a percentage line when the window is known:

```ts
import { describe, expect, it } from "vitest";
import { contextCommand } from "./context.js";
import { ConversationManager } from "../../../conversation/manager.js";

describe("/context command", () => {
  it("renders token percentage when window is published", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.setContextBudget({ contextWindow: 200000, outputReserve: 8192 });
    mgr.replaceMessages([
      { role: "user", content: "hi", timestamp: new Date().toISOString() },
      { role: "assistant", content: "hello", timestamp: new Date().toISOString() },
    ]);
    const res = await contextCommand.execute([], {
      conversation: mgr,
      workingDirectory: process.cwd(),
    } as never);
    const msg = (res as { message: string }).message;
    expect(msg).toMatch(/%\s*\(/); // e.g. "0% (1k/200k)"
    expect(msg).toContain("Window: 200000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/core/src/extensions/commands/builtin/context.test.ts`
Expected: FAIL — no percentage line.

- [ ] **Step 3: Write minimal implementation**

(a) `packages/core/src/extensions/commands/builtin/context.ts` — add a percentage line in the `Window:` block:

```ts
    if (budget.contextWindow > 0) {
      const pct = Math.round((budget.used / budget.contextWindow) * 100);
      info.push(
        `Window: ${budget.contextWindow} (reserve ${budget.outputReserve})`
      );
      info.push(`Used: ${pct}% (${budget.used}/${budget.contextWindow})`);
      info.push(`Remaining: ${budget.remaining}`);
    }
```

(Keep the existing `Overflow` count block.)

(b) `packages/core/src/index.ts` — add exports alongside the existing context exports:

```ts
export { getRecoveryPointer } from "./context/git-pointer.js";
export type { RecoveryPointer } from "./context/git-pointer.js";
export {
  computeStats,
  buildFileChangeMessage,
  isFileChangeMessage,
  parseFileChangeMessage,
  WRITE_TOOL_NAMES,
  EDIT_TOOL_NAMES,
} from "./context/file-change.js";
export type { FileChangeNote, FileChangeStats, FileChangeOperation } from "./context/file-change.js";
export { CompressionAssistant } from "./context/summarizer.js";
export type {
  CompressionTurnInput,
  CompressionAssistResult,
} from "./context/summarizer.js";
export { classifyMiddleTurns, extractExistingSummary, isSummaryMessage } from "./context/compressor.js";
```

- [ ] **Step 4: Run the full suite + build**

Run: `pnpm test`
Expected: all tests PASS (only pre-existing unrelated MCP-startup test may fail, per project baseline).

Run: `pnpm build`
Expected: zero TypeScript errors.

- [ ] **Step 5: Manual acceptance (optional, real CLI)**

In the worktree: `pnpm build && pnpm start` (or `./tools.sh session`), start a long session, and verify:
- Status bar shows `tokens: <pct>% (<used>k/<window>k)`.
- After the context crosses the threshold, a `已压缩 N 条消息` notice appears and the percentage drops.
- `/context` shows `Used: <pct>% (...)` + Window/Remaining.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/extensions/commands/builtin/context.ts packages/core/src/extensions/commands/builtin/context.test.ts packages/core/src/index.ts
git commit -m "feat(context): /context percentage + export Phase 5 modules"
```

---

## Self-Review Notes

**Spec coverage:**
- §三 三层模型 → Task 5 (classify) + Task 6 (compress: must-keep, should-keep via assistant, budget shed) ✓
- §五 file_change 压缩 → Task 2 (note) + Task 6 (buildNote, pointer via Task 1) ✓
- §六 统一 side-call → Task 3 ✓
- §七 滚动演化摘要 → Task 6 (existingSummary extract + rolling method) + Task 3 (merge prompt) ✓
- §八 预算裁剪 → Task 6 (budget loop) + Task 7 (budgetTokens passed) ✓
- §九 事件 + /context + 状态栏百分比 → Task 4 (event) + Task 9 (status bar) + Task 10 (/context) ✓
- §十 ContextConfig 开关 → Task 7 (loop) + Task 8 (env wiring) ✓
- §十一 验收 → covered by Tasks 1-10 tests ✓
- §十二 回退 → Task 8 env flags (LICODE_CONTEXT_*) + omitting `compressor` (existing) ✓

**Placeholder scan:** Task 7's loop test defers to the existing `loop.test.ts` harness pattern rather than duplicating a full mock-provider setup — acceptable since the harness already exists in that file; the implementer reuses it. No "TBD"/"TODO" elsewhere.

**Type consistency:** `CompressionTurnInput`, `CompressionAssistResult`, `FileChangeNote`, `RecoveryPointer`, `CompressOptions`, `CompressionResult` field names are used identically across tasks. `compressionAssistant.assist({ existingSummary, turns })` signature matches between Task 3 (producer), Task 6 (consumer), Task 8 (CLI). `getRecoveryPointer(content, workingDirectory)` matches Task 1 and Task 6. `budgetTokens` matches Task 6 + Task 7.
