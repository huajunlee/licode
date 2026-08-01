import * as fs from "node:fs";
import * as path from "node:path";
import type { DiaryEntry } from "./types.js";
import { serializeEntry, parseEntry } from "./serialize.js";

export interface DiaryStore {
  save(entry: DiaryEntry): Promise<void>;
  load(id: string): Promise<DiaryEntry | null>;
  listByDate(date: string): Promise<DiaryEntry[]>;
  listRecent(limit: number): Promise<DiaryEntry[]>;
  listAll(): Promise<DiaryEntry[]>;
  search(query: string): Promise<DiaryEntry[]>;
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

export class JournalStore implements DiaryStore {
  constructor(private dir: string) {}

  async save(entry: DiaryEntry): Promise<void> {
    const dateDir = path.join(this.dir, entry.meta.date);
    await fs.promises.mkdir(dateDir, { recursive: true });
    const filePath = path.join(dateDir, `${entry.meta.id}.md`);
    if (fs.existsSync(filePath)) {
      throw new Error(`diary entry already exists: ${entry.meta.id}`);
    }
    await fs.promises.writeFile(filePath, serializeEntry(entry), "utf-8");
  }

  async load(id: string): Promise<DiaryEntry | null> {
    if (!fs.existsSync(this.dir)) return null;
    for (const dateDir of await fs.promises.readdir(this.dir)) {
      const filePath = path.join(this.dir, dateDir, `${id}.md`);
      if (fs.existsSync(filePath)) {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        return parseEntry(raw);
      }
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

  async search(query: string): Promise<DiaryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const q = query.toLowerCase();
    const all: DiaryEntry[] = [];
    for (const date of await fs.promises.readdir(this.dir)) {
      const dateDir = path.join(this.dir, date);
      const stat = await fs.promises.stat(dateDir);
      if (!stat.isDirectory()) continue;
      all.push(...(await readEntries(dateDir)));
    }
    return all.filter((e) => {
      const hay = [
        e.raw.content,
        e.summary,
        ...e.people.map((p) => p.name),
        ...e.facts.map((f) => f.what),
      ].join("\n").toLowerCase();
      return hay.includes(q);
    });
  }
}
