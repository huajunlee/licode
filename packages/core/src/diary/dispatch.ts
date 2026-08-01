import type { DiaryEntry } from "./types.js";
import { dateString } from "./types.js";
import { hhmmFromISO } from "../memory/types.js";
import { DiarySession } from "./session.js";
import type { DiaryStore } from "./store.js";
import type { DiaryExtractorLike } from "./extractor.js";

export interface DiaryDispatchDeps {
  extractor: DiaryExtractorLike;
  store: DiaryStore;
  now: () => Date;
}
export interface DiaryDispatchContext extends DiaryDispatchDeps {
  session: DiarySession | null;
}
export interface DiaryDispatchResult {
  type: "action" | "error";
  message: string;
}
export interface DiaryDispatchOutcome {
  result: DiaryDispatchResult;
  nextSession: DiarySession | null;
  /** /diary-end 时刚保存的条目；hooks 用它跑自动提升/入档（不要用 listRecent 重查，多条同日会取错）。 */
  entry?: DiaryEntry;
}

const RECENT_LIMIT = 10;

function formatPreview(e: DiaryEntry): string {
  const title = e.title || (e.summary.length > 60 ? e.summary.slice(0, 60) + "…" : e.summary);
  const hhmm = hhmmFromISO(e.meta.createdAt);
  return `[${e.meta.date} ${hhmm}] ${title} (${e.meta.id})`;
}

export async function handleDiaryInput(
  input: string,
  ctx: DiaryDispatchContext
): Promise<DiaryDispatchOutcome | null> {
  const trimmed = input.trim();

  if (trimmed.startsWith("/diary")) {
    const rest = trimmed.slice("/diary".length).trim();
    const sub = (rest.split(/\s+/)[0] ?? "").replace(/^-/, "");

    // /diary or /diary start
    if (sub === "" || sub === "start") {
      if (ctx.session) {
        return { result: { type: "error", message: "已在日记模式，请先 /diary-end 结束当前会话。" }, nextSession: ctx.session };
      }
      const session = new DiarySession(dateString(ctx.now()), ctx.now());
      return {
        result: { type: "action", message: "📖 进入日记模式。描述今天发生的事，结束说 /diary-end（查看历史：/diary-list、/diary-find、/diary-show）。" },
        nextSession: session,
      };
    }

    // /diary end
    if (sub === "end") {
      if (!ctx.session) {
        return { result: { type: "error", message: "当前没有进行中的日记会话。" }, nextSession: null };
      }
      const entry = await ctx.session.end(ctx.extractor, ctx.now());
      await ctx.store.save(entry);
      return {
        result: { type: "action", message: `✅ 已保存今日日记：\n${entry.summary || "（无摘要）"}` },
        nextSession: null,
        entry,
      };
    }

    // recall commands require no active session
    if (ctx.session) {
      return { result: { type: "error", message: "请先 /diary-end 结束当前会话再查询。" }, nextSession: ctx.session };
    }

    if (sub === "list") {
      const dateArg = rest.split(/\s+/)[1];
      const entries = dateArg ? await ctx.store.listByDate(dateArg) : await ctx.store.listRecent(RECENT_LIMIT);
      if (entries.length === 0) return { result: { type: "action", message: "📭 没有日记条目。" }, nextSession: null };
      return { result: { type: "action", message: `📒 日记（${entries.length}）：\n${entries.map(formatPreview).join("\n")}` }, nextSession: null };
    }
    if (sub === "find") {
      const q = rest.split(/\s+/).slice(1).join(" ").trim();
      if (!q) return { result: { type: "error", message: "使用方式: /diary-find <关键词>" }, nextSession: null };
      const entries = await ctx.store.search(q);
      if (entries.length === 0) return { result: { type: "action", message: `没有匹配“${q}”的日记。` }, nextSession: null };
      return { result: { type: "action", message: `🔎 匹配“${q}”（${entries.length}）：\n${entries.map(formatPreview).join("\n")}` }, nextSession: null };
    }
    if (sub === "show") {
      const id = rest.split(/\s+/)[1];
      if (!id) return { result: { type: "error", message: "使用方式: /diary-show <id>" }, nextSession: null };
      const e = await ctx.store.load(id);
      if (!e) return { result: { type: "error", message: `未找到日记 ${id}。` }, nextSession: null };
      return { result: { type: "action", message: `📝 ${e.meta.date} ${e.meta.id}\n\n摘要：${e.summary}\n\n原文：\n${e.raw.segments.map((s) => s.content).join("\n")}` }, nextSession: null };
    }
    return { result: { type: "error", message: "未知子命令。使用: /diary | /diary-end | /diary-list [date] | /diary-find <关键词> | /diary-show <id>" }, nextSession: null };
  }

  // plain input during active session -> capture
  if (ctx.session) {
    ctx.session.addSegment(trimmed, ctx.now());
    return { result: { type: "action", message: "✓ 已记下（继续描述，或 /diary-end 结束）" }, nextSession: ctx.session };
  }

  return null;
}
