import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry } from "./types.js";

export class MemoryStore {
  constructor(private dir: string) {}

  async save(entry: MemoryEntry): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${entry.id}.md`);
    const tags = entry.tags?.join(", ") ?? "";
    const content = [
      "---",
      `id: ${entry.id}`,
      `title: ${entry.title}`,
      `tags: ${tags}`,
      "---",
      "",
      entry.content,
      "",
    ].join("\n");
    await fs.promises.writeFile(filePath, content, "utf-8");
  }

  async list(): Promise<MemoryEntry[]> {
    if (!fs.existsSync(this.dir)) return [];
    const files = (await fs.promises.readdir(this.dir)).filter((file) =>
      file.endsWith(".md")
    );
    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const raw = await fs.promises.readFile(path.join(this.dir, file), "utf-8");
      entries.push(this.parse(raw, path.basename(file, ".md")));
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  private parse(raw: string, fallbackId: string): MemoryEntry {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) {
      return {
        id: fallbackId,
        title: fallbackId,
        content: raw.trim(),
      };
    }

    const frontmatter = new Map<string, string>();
    for (const line of match[1].split("\n")) {
      const index = line.indexOf(":");
      if (index === -1) continue;
      frontmatter.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }

    const tags = frontmatter.get("tags");
    return {
      id: frontmatter.get("id") ?? fallbackId,
      title: frontmatter.get("title") ?? fallbackId,
      content: match[2].trim(),
      tags: tags ? tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    };
  }
}
