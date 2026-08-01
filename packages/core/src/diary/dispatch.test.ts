import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleDiaryInput } from "./dispatch.js";
import { JournalStore } from "./store.js";
import type { DiaryExtractorLike, ExtractInput } from "./extractor.js";
import type { DiaryEntry } from "./types.js";

function fakeExtractor(): DiaryExtractorLike {
  return {
    async extract(input: ExtractInput): Promise<DiaryEntry> {
      return {
        meta: { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt },
        raw: { content: input.content, segments: input.segments },
        title: "今日标题",
        summary: "今日摘要",
        facts: [], decisions: [], emotions: [], people: [], futureMemory: [],
      };
    },
  };
}

describe("handleDiaryInput", () => {
  let dir: string;
  const now = () => new Date("2026-07-31T10:00:00.000Z");
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "disp-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const ctx = (session: null) => ({
    session, extractor: fakeExtractor(), store: new JournalStore(dir), now,
  });

  it("returns null for non-diary input with no active session", async () => {
    expect(await handleDiaryInput("帮我写代码", ctx(null))).toBeNull();
  });

  it("/diary starts a session", async () => {
    const out = await handleDiaryInput("/diary", ctx(null));
    expect(out).not.toBeNull();
    expect(out!.result.type).toBe("action");
    expect(out!.nextSession).not.toBeNull();
  });

  it("captures plain input when session active (no AgentLoop)", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const out = await handleDiaryInput("今天和老板聊了项目", { ...ctx(null), session: started!.nextSession });
    expect(out!.result.message).toMatch(/已记下/);
    expect(out!.nextSession).toBe(started!.nextSession);
  });

  it("/diary end extracts, stores, clears session, returns summary", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const session = started!.nextSession;
    await handleDiaryInput("今天和老板聊了项目", { ...ctx(null), session });
    const out = await handleDiaryInput("/diary end", { ...ctx(null), session });
    expect(out!.result.message).toContain("今日摘要");
    expect(out!.nextSession).toBeNull();
    expect(out!.entry).toBeDefined();            // 刚保存的条目回传（hooks 用它跑自动提升/入档）
    expect(out!.entry!.raw.segments.length).toBe(1);
    const list = await new JournalStore(dir).listByDate("2026-07-31");
    expect(list.length).toBe(1);
  });

  it("/diary end with no session is an error", async () => {
    const out = await handleDiaryInput("/diary end", ctx(null));
    expect(out!.result.type).toBe("error");
  });

  it("/diary list shows recent entries", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    await handleDiaryInput("内容一", { ...ctx(null), session: started!.nextSession });
    await handleDiaryInput("/diary end", { ...ctx(null), session: started!.nextSession });
    const out = await handleDiaryInput("/diary list", ctx(null));
    expect(out!.result.message).toContain("2026-07-31");
  });

  it("/diary while session active is an error (end first)", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const out = await handleDiaryInput("/diary", { ...ctx(null), session: started!.nextSession });
    expect(out!.result.type).toBe("error");
  });

  it("/diary-end (hyphen form) ends and stores", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    const session = started!.nextSession;
    await handleDiaryInput("内容", { ...ctx(null), session });
    const out = await handleDiaryInput("/diary-end", { ...ctx(null), session });
    expect(out!.result.message).toContain("今日摘要");
    expect(out!.nextSession).toBeNull();
    const list = await new JournalStore(dir).listByDate("2026-07-31");
    expect(list.length).toBe(1);
  });

  it("/diary-list (hyphen form) shows entries", async () => {
    const started = await handleDiaryInput("/diary", ctx(null));
    await handleDiaryInput("内容", { ...ctx(null), session: started!.nextSession });
    await handleDiaryInput("/diary-end", { ...ctx(null), session: started!.nextSession });
    const out = await handleDiaryInput("/diary-list", ctx(null));
    expect(out!.result.message).toContain("2026-07-31");
  });
});
