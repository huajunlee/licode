import * as fs from "node:fs";
import * as path from "node:path";
import type { Memory, MemoryType } from "./types.js";

const INDEX_HEADER = "# User Memory\n\nThe following memories are from previous conversations:\n\n";

export class MemoryStore {
  constructor(private dir: string) {}

  async save(memory: Memory): Promise<void> {
    const typeDir = path.join(this.dir, memory.type);
    await fs.promises.mkdir(typeDir, { recursive: true });

    const filePath = path.join(typeDir, `${path.basename(memory.slug)}.md`);

    // Append-merge: if target file exists, append content
    let finalContent = memory.content;
    if (fs.existsSync(filePath)) {
      const existing = await this.load(memory.slug);
      if (existing && !existing.content.includes(memory.content)) {
        finalContent = existing.content + "\n\n" + memory.content;
      }
    }

    const frontmatter = [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `createdAt: ${memory.createdAt}`,
      `updatedAt: ${memory.updatedAt}`,
      "---",
      "",
      finalContent,
      "",
    ].join("\n");

    await fs.promises.writeFile(filePath, frontmatter, "utf-8");
    await this.updateIndex();
  }

  async load(slug: string): Promise<Memory | null> {
    // Search all type directories for the slug
    const types: MemoryType[] = ["user", "feedback", "project", "reference"];
    for (const type of types) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (fs.existsSync(filePath)) {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        return this.parse(raw, slug, type);
      }
    }
    return null;
  }

  async delete(slug: string): Promise<void> {
    const types: MemoryType[] = ["user", "feedback", "project", "reference"];
    for (const type of types) {
      const filePath = path.join(this.dir, type, `${path.basename(slug)}.md`);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        // Clean up empty type directory
        const remaining = await fs.promises.readdir(path.join(this.dir, type));
        if (remaining.length === 0) {
          // Don't remove the dir, just leave it empty
        }
        await this.updateIndex();
        return;
      }
    }
  }

  async listAll(): Promise<Memory[]> {
    if (!fs.existsSync(this.dir)) return [];

    const types: MemoryType[] = ["user", "feedback", "project", "reference"];
    const memories: Memory[] = [];

    for (const type of types) {
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

  private async updateIndex(): Promise<void> {
    const all = await this.listAllRaw();
    if (all.length === 0) {
      const indexPath = path.join(this.dir, "MEMORY.md");
      try { await fs.promises.unlink(indexPath); } catch { /* ok */ }
      return;
    }

    const lines = all.map(
      (m) => `- [${m.name}](${path.join(this.dir, m.slug)}.md) — ${m.description}`
    );

    const content = INDEX_HEADER + lines.join("\n") + "\n";

    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(path.join(this.dir, "MEMORY.md"), content, "utf-8");
  }

  /**
   * Read all markdown memory files directly without going through parse().
   * Used internally by updateIndex() to avoid double-parsing.
   */
  private async listAllRaw(): Promise<Array<{ slug: string; name: string; description: string }>> {
    if (!fs.existsSync(this.dir)) return [];

    const types: MemoryType[] = ["user", "feedback", "project", "reference"];
    const items: Array<{ slug: string; name: string; description: string }> = [];

    for (const type of types) {
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
    };
  }
}
