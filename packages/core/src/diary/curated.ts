import * as fs from "node:fs";
import * as path from "node:path";

export class CuratedIndex {
  constructor(private filePath: string) {}

  async load(): Promise<Set<string>> {
    try {
      const raw = await fs.promises.readFile(this.filePath, "utf-8");
      const obj = JSON.parse(raw) as { processed?: string[] };
      return new Set(obj.processed ?? []);
    } catch {
      return new Set();
    }
  }

  async mark(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const current = await this.load();
    for (const k of keys) current.add(k);
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(
      this.filePath,
      JSON.stringify({ processed: [...current].sort() }, null, 2),
      "utf-8"
    );
  }
}
