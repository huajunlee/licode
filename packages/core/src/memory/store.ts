import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeDates } from "./normalize-dates.js";
import type { Memory, MemoryType } from "./types.js";

const INDEX_HEADER = "# User Memory\n\nThe following memories are from previous conversations:\n\n";

const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

/**
 * Write semantics for {@link MemoryStore.save}.
 *
 * - `create`：新建文件；若目标已存在则**防御性降级为 append**（LLM 误标时不丢旧内容）
 * - `update`：正文整体替换；保留现有 `createdAt`，刷新 `updatedAt`
 * - `append`：段落级去重追加（按空行分段，已有相同段落则跳过）
 */
export type MemoryAction = "create" | "update" | "append";

/**
 * Merge `addition` into `existing` paragraph by paragraph.
 * Paragraphs are split on blank lines; paragraphs already present in
 * `existing` are skipped. Returns `existing` unchanged when every
 * paragraph of `addition` is already present.
 */
function mergeAppend(existing: string, addition: string): string {
  const existingParagraphs = existing
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const additionParagraphs = addition
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const seen = new Set(existingParagraphs);
  const fresh = additionParagraphs.filter((p) => !seen.has(p));

  if (fresh.length === 0) return existing;
  if (existingParagraphs.length === 0) return fresh.join("\n\n");
  return [...existingParagraphs, ...fresh].join("\n\n");
}

export class MemoryStore {
  constructor(private dir: string) {}

  async save(memory: Memory, action: MemoryAction = "create"): Promise<void> {
    const typeDir = path.join(this.dir, memory.type);
    await fs.promises.mkdir(typeDir, { recursive: true });

    const filePath = path.join(typeDir, `${path.basename(memory.slug)}.md`);
    const exists = fs.existsSync(filePath);

    // create on an existing file degrades to append — never lose old content
    const effectiveAction: MemoryAction =
      action === "create" && exists ? "append" : action;

    let finalContent = memory.content;
    let createdAt = memory.createdAt;
    let updatedAt = memory.updatedAt;
    // Phase 4: usage fields. create(new file) -> 0/"" (a new memory is unused);
    // update/append -> preserve existing (content change ≠ usage event; never
    // reset the forgetting clock on a content edit).
    let usageCount = 0;
    let lastUsedAt = "";
    let pinned = memory.pinned ?? false;

    if (effectiveAction === "update") {
      // Replace content wholesale; keep the original createdAt, refresh updatedAt
      if (exists) {
        const existing = await this.load(memory.slug);
        if (existing) {
          createdAt = existing.createdAt;
          usageCount = existing.usageCount ?? 0;
          lastUsedAt = existing.lastUsedAt ?? "";
          pinned = existing.pinned ?? false;
        }
      }
      updatedAt = new Date().toISOString();
    } else if (effectiveAction === "append" && exists) {
      const existing = await this.load(memory.slug);
      if (existing) {
        finalContent = mergeAppend(existing.content, memory.content);
        usageCount = existing.usageCount ?? 0;
        lastUsedAt = existing.lastUsedAt ?? "";
        pinned = existing.pinned ?? false;
      }
    }

    // 程序化归一化：落盘前把 content+description 的精确相对词转绝对日期。
    // 锚点 now（写入时间）；幂等；try/catch 兜底，绝不阻断 save。
    // 对 description 也跑——从结构上封死 dream consolidate 看不到 description 的盲区。
    const writeNow = new Date();
    try {
      finalContent = normalizeDates(finalContent, writeNow);
      memory.description = normalizeDates(memory.description, writeNow);
    } catch {
      // best-effort: 归一化失败则保留原文
    }

    const frontmatter = [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `createdAt: ${createdAt}`,
      `updatedAt: ${updatedAt}`,
      `usageCount: ${usageCount}`,
      `lastUsedAt: ${lastUsedAt}`,
      `pinned: ${pinned}`,
      "---",
      "",
      finalContent,
      "",
    ].join("\n");

    await fs.promises.writeFile(filePath, frontmatter, "utf-8");
    await this.rebuildIndex();
  }

  async load(slug: string): Promise<Memory | null> {
    // Search all type directories for the slug
    for (const type of MEMORY_TYPES) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (fs.existsSync(filePath)) {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        return this.parse(raw, slug, type);
      }
    }
    return null;
  }

  async delete(slug: string): Promise<void> {
    for (const type of MEMORY_TYPES) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        await this.rebuildIndex();
        return;
      }
    }
  }

  async listAll(): Promise<Memory[]> {
    if (!fs.existsSync(this.dir)) return [];

    const memories: Memory[] = [];

    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(this.dir, type);
      if (!fs.existsSync(typeDir)) continue;

      const files = (await fs.promises.readdir(typeDir))
        .filter((f) => f.endsWith(".md"));

      for (const file of files) {
        const raw = await fs.promises.readFile(path.join(typeDir, file), "utf-8");
        const slug = `${type}/${path.basename(file, ".md")}`;
        memories.push(this.parse(raw, slug, type));
      }
    }

    return memories.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * @deprecated 使用 listAll() 替代
   */
  async list(): Promise<import("./types.js").MemoryEntry[]> {
    const all = await this.listAll();
    return all.map((m) => ({
      id: m.slug.replace("/", "-"),
      title: m.name,
      content: m.content,
      tags: [m.type],
    }));
  }

  async loadIndex(): Promise<string> {
    const indexPath = path.join(this.dir, "MEMORY.md");
    if (!fs.existsSync(indexPath)) return "";
    return await fs.promises.readFile(indexPath, "utf-8");
  }

  /**
   * Rebuild MEMORY.md from the current on-disk memory files.
   *
   * Public so callers can pick up memory files written directly to disk
   * (e.g. the main agent using the Write tool, bypassing {@link save}).
   * Index lines use paths relative to the memory directory.
   */
  async rebuildIndex(): Promise<void> {
    const all = await this.listAllRaw();
    if (all.length === 0) {
      const indexPath = path.join(this.dir, "MEMORY.md");
      try { await fs.promises.unlink(indexPath); } catch { /* ok */ }
      return;
    }

    const lines = all.map(
      (m) => `- [${m.name}](${m.slug}.md) — ${m.description}`
    );

    const content = INDEX_HEADER + lines.join("\n") + "\n";

    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(path.join(this.dir, "MEMORY.md"), content, "utf-8");
  }

  /**
   * Returns true when any memory file (in the type subdirectories) has been
   * modified at or after `tsMs`. MEMORY.md itself is excluded — only actual
   * memory files count, so index rebuilds don't register as "changes".
   */
  async hasChangesSince(tsMs: number): Promise<boolean> {
    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(this.dir, type);
      if (!fs.existsSync(typeDir)) continue;

      const files = (await fs.promises.readdir(typeDir))
        .filter((f) => f.endsWith(".md"));

      for (const file of files) {
        const stat = await fs.promises.stat(path.join(typeDir, file));
        if (stat.mtimeMs >= tsMs) return true;
      }
    }
    return false;
  }

  /**
   * Phase 4: record a recall-injection usage event for `slug`.
   *
   * Increments usageCount, sets lastUsedAt=now, preserves everything else
   * (name/description/type/createdAt/updatedAt/content). Restores the original
   * mtime so the write is invisible to {@link hasChangesSince} -- this is the
   * fix for the Phase 2/3 pre-noted mtime坑 (otherwise each recall would bump
   * mtime ≥ loopStartedAt and the extraction hook would skip extraction as
   * "main agent already wrote"). Does NOT rebuildIndex (usage fields are not
   * in the index). Best-effort: a missing slug or utimes failure is swallowed.
   */
  async recordUsage(slug: string): Promise<void> {
    for (const type of MEMORY_TYPES) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(filePath)) continue;
      const stat = await fs.promises.stat(filePath);
      const mtimeMs = stat.mtimeMs;
      const atimeMs = stat.atimeMs;
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const existing = this.parse(raw, slug, type);
      const usageCount = (existing.usageCount ?? 0) + 1;
      const lastUsedAt = new Date().toISOString();
      const frontmatter = [
        "---",
        `name: ${existing.name}`,
        `description: ${existing.description}`,
        `type: ${existing.type}`,
        `createdAt: ${existing.createdAt}`,
        `updatedAt: ${existing.updatedAt}`,
        `usageCount: ${usageCount}`,
        `lastUsedAt: ${lastUsedAt}`,
        "---",
        "",
        existing.content,
        "",
      ].join("\n");
      await fs.promises.writeFile(filePath, frontmatter, "utf-8");
      // Restore original mtime -> invisible to hasChangesSince(loopStartedAt).
      await fs.promises
        .utimes(filePath, atimeMs / 1000, mtimeMs / 1000)
        .catch(() => {});
      return; // first matching type dir wins
    }
  }

  /**
   * Phase 4: retire a memory to archive/<type>/ (soft-delete, recoverable).
   *
   * The file leaves the type directory so listAll/rebuildIndex/hasChangesSince
   * no longer see it. Does NOT rebuildIndex (the caller - Dream's Prune - does
   * that once). A missing slug is a silent no-op.
   */
  async archive(slug: string): Promise<void> {
    for (const type of MEMORY_TYPES) {
      const src = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(src)) continue;
      const dstDir = path.join(this.dir, "archive", type);
      await fs.promises.mkdir(dstDir, { recursive: true });
      await fs.promises.rename(src, path.join(dstDir, `${path.basename(slug)}.md`));
      return;
    }
  }

  /** Phase 4: list memories retired to archive/. */
  async listArchived(): Promise<Memory[]> {
    const archiveDir = path.join(this.dir, "archive");
    if (!fs.existsSync(archiveDir)) return [];
    const memories: Memory[] = [];
    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(archiveDir, type);
      if (!fs.existsSync(typeDir)) continue;
      const files = (await fs.promises.readdir(typeDir)).filter((f) =>
        f.endsWith(".md")
      );
      for (const file of files) {
        const raw = await fs.promises.readFile(path.join(typeDir, file), "utf-8");
        memories.push(this.parse(raw, `${type}/${path.basename(file, ".md")}`, type));
      }
    }
    return memories.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Phase 4: restore an archived memory back to its type directory and rebuild
   * the index so it re-enters recall candidates. Returns the restored memory,
   * or null if not found in archive/.
   */
  async restore(slug: string): Promise<Memory | null> {
    for (const type of MEMORY_TYPES) {
      const src = path.join(this.dir, "archive", type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(src)) continue;
      const dstDir = path.join(this.dir, type);
      await fs.promises.mkdir(dstDir, { recursive: true });
      await fs.promises.rename(src, path.join(dstDir, `${path.basename(slug)}.md`));
      await this.rebuildIndex();
      return this.load(slug);
    }
    return null;
  }

  /**
   * Phase 4: set the `pinned` flag on a memory. Pinned memories are excluded
   * from archive candidates (never auto-archived). Rewrites frontmatter
   * preserving everything else. Returns the updated memory, or null if missing.
   */
  async setPinned(slug: string, pinned: boolean): Promise<Memory | null> {
    for (const type of MEMORY_TYPES) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (!fs.existsSync(filePath)) continue;
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const existing = this.parse(raw, slug, type);
      const frontmatter = [
        "---",
        `name: ${existing.name}`,
        `description: ${existing.description}`,
        `type: ${existing.type}`,
        `createdAt: ${existing.createdAt}`,
        `updatedAt: ${existing.updatedAt}`,
        `usageCount: ${existing.usageCount ?? 0}`,
        `lastUsedAt: ${existing.lastUsedAt ?? ""}`,
        `pinned: ${pinned}`,
        "---",
        "",
        existing.content,
        "",
      ].join("\n");
      await fs.promises.writeFile(filePath, frontmatter, "utf-8");
      return this.parse(frontmatter, slug, type);
    }
    return null;
  }

  /**
   * Read all markdown memory files directly without going through parse().
   * Used internally by rebuildIndex() to avoid double-parsing.
   */
  private async listAllRaw(): Promise<Array<{ slug: string; name: string; description: string }>> {
    if (!fs.existsSync(this.dir)) return [];

    const items: Array<{ slug: string; name: string; description: string }> = [];

    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(this.dir, type);
      if (!fs.existsSync(typeDir)) continue;

      const files = (await fs.promises.readdir(typeDir))
        .filter((f) => f.endsWith(".md"));

      for (const file of files) {
        const raw = await fs.promises.readFile(path.join(typeDir, file), "utf-8");
        const parsed = this.parse(raw, `${type}/${path.basename(file, ".md")}`, type);
        items.push({
          slug: parsed.slug,
          name: parsed.name,
          description: parsed.description,
        });
      }
    }

    return items.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private parse(raw: string, slug: string, type: string): Memory {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) {
      return {
        slug,
        type: type as MemoryType,
        name: path.basename(slug),
        description: "",
        content: raw.trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const fm = new Map<string, string>();
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      fm.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }

    return {
      slug,
      type: (fm.get("type") as MemoryType) ?? (type as MemoryType),
      name: fm.get("name") ?? path.basename(slug),
      description: fm.get("description") ?? "",
      content: match[2].trim(),
      createdAt: fm.get("createdAt") ?? new Date().toISOString(),
      updatedAt: fm.get("updatedAt") ?? new Date().toISOString(),
      usageCount: fm.has("usageCount") ? Number(fm.get("usageCount")) || 0 : 0,
      lastUsedAt: fm.get("lastUsedAt") ?? "",
      pinned: fm.get("pinned") === "true",
    };
  }
}
