import * as fs from "node:fs";
import * as path from "node:path";
import type { DiaryEntry } from "./types.js";
import { serializeEntry, parseEntry } from "./serialize.js";
import { cleanName, hhmmFromISO } from "../memory/types.js";

export interface DiaryStore {
  save(entry: DiaryEntry): Promise<void>;
  load(id: string): Promise<DiaryEntry | null>;
  listByDate(date: string): Promise<DiaryEntry[]>;
  listRecent(limit: number): Promise<DiaryEntry[]>;
  listAll(): Promise<DiaryEntry[]>;
  listRange(start: string, end: string): Promise<DiaryEntry[]>;
  search(query: string, range?: { start: string; end: string }): Promise<DiaryEntry[]>;
}

async function readEntries(dir: string): Promise<DiaryEntry[]> {
  if (!fs.existsSync(dir)) return [];
  const out: DiaryEntry[] = [];
  for (const file of await fs.promises.readdir(dir)) {
    if (!file.endsWith(".md")) continue;
    const raw = await fs.promises.readFile(path.join(dir, file), "utf-8");
    const parsed = parseEntry(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

function entryFilename(entry: DiaryEntry): string {
  const hhmm = hhmmFromISO(entry.meta.createdAt);
  const title = cleanName(entry.title).slice(0, 12).replace(/-+$/, "") || "无标题";
  return `${entry.meta.date}-${hhmm}-${title}.md`;
}

/** 升序稳定排序：先按日期（YYYY-MM-DD 字典序即时间序），同日内按 id。 */
function byDate(a: DiaryEntry, b: DiaryEntry): number {
  return (
    a.meta.date.localeCompare(b.meta.date) || a.meta.id.localeCompare(b.meta.id)
  );
}

/** 参与检索的文本：原文 + 摘要 + 人名 + 事实，全部转小写。 */
function haystack(e: DiaryEntry): string {
  return [
    e.raw.content,
    e.summary,
    ...e.people.map((p) => p.name),
    ...e.facts.map((f) => f.what),
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * 按空白切词。调用方（journal_recall 的 query、/diary-find）传的是模型或用户写的
 * 关键词串，如「字节跳动 投递简历 面试」——之前整串当一个子串匹配，只要其中一个词
 * 不在原文里就整条查不到，等于多词查询全部失效，所以必须切词。
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export class JournalStore implements DiaryStore {
  constructor(private dir: string) {}

  async save(entry: DiaryEntry): Promise<void> {
    const dateDir = path.join(this.dir, entry.meta.date);
    await fs.promises.mkdir(dateDir, { recursive: true });
    const filePath = this.resolveUniquePath(dateDir, entry);
    await fs.promises.writeFile(filePath, serializeEntry(entry), "utf-8");
  }

  private resolveUniquePath(dateDir: string, entry: DiaryEntry): string {
    const name = entryFilename(entry);
    let candidate = path.join(dateDir, name);
    if (!fs.existsSync(candidate)) return candidate;
    const base = name.replace(/\.md$/, "");
    let i = 2;
    while (fs.existsSync(path.join(dateDir, `${base}-${i}.md`))) i++;
    return path.join(dateDir, `${base}-${i}.md`);
  }

  async load(id: string): Promise<DiaryEntry | null> {
    if (!fs.existsSync(this.dir)) return null;
    for (const dateDir of await fs.promises.readdir(this.dir)) {
      const full = path.join(this.dir, dateDir);
      const stat = await fs.promises.stat(full);
      if (!stat.isDirectory()) continue;
      const found = (await readEntries(full)).find((e) => e.meta.id === id);
      if (found) return found;
    }
    return null;
  }

  async listByDate(date: string): Promise<DiaryEntry[]> {
    return readEntries(path.join(this.dir, date));
  }

  async listRecent(limit: number): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const dates = (await fs.promises.readdir(this.dir))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    const out: DiaryEntry[] = [];
    for (const date of dates) {
      const entries = await readEntries(path.join(this.dir, date));
      out.push(...entries);
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  async listAll(): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const out: DiaryEntry[] = [];
    for (const date of await fs.promises.readdir(this.dir)) {
      const dateDir = path.join(this.dir, date);
      const stat = await fs.promises.stat(dateDir);
      if (!stat.isDirectory()) continue;
      out.push(...(await readEntries(dateDir)));
    }
    return out;
  }

  /** 读取日期目录下所有条目，可选按 [start, end] 日期范围过滤（目录名字典序即时间序）。 */
  private async readRange(
    start?: string,
    end?: string
  ): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const out: DiaryEntry[] = [];
    for (const date of await fs.promises.readdir(this.dir)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (start !== undefined && date < start) continue;
      if (end !== undefined && date > end) continue;
      const dateDir = path.join(this.dir, date);
      const stat = await fs.promises.stat(dateDir);
      if (!stat.isDirectory()) continue;
      out.push(...(await readEntries(dateDir)));
    }
    return out;
  }

  async listRange(start: string, end: string): Promise<DiaryEntry[]> {
    return (await this.readRange(start, end)).sort(byDate);
  }

  /**
   * 关键词检索：命中**任一词**即返回（OR），命中词多的排前面，同分再按日期。
   * 用 OR 而非 AND 是刻意的——这是召回工具，宁可多给几条让模型自己筛，
   * 也不要因为用户顺口多写一个词就返回空（"面试"没写进日记就整条查不到，
   * 正是之前的病）。打分让「三个词全中」的条目浮到最上面，弥补放宽带来的噪声。
   */
  async search(
    query: string,
    range?: { start: string; end: string }
  ): Promise<DiaryEntry[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const scored = (await this.readRange(range?.start, range?.end)).map((e) => {
      const hay = haystack(e);
      return { entry: e, score: tokens.filter((t) => hay.includes(t)).length };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || byDate(a.entry, b.entry))
      .map((s) => s.entry);
  }
}
