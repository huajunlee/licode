import * as fs from "node:fs";
import * as path from "node:path";
import type { PersonProfile } from "./types.js";
import { serializeProfile, parseProfile } from "./serialize.js";

export type ProfileAction = "create" | "update";

export class PersonProfileStore {
  constructor(private dir: string) {}

  private file(slug: string): string {
    return path.join(this.dir, `${path.basename(slug)}.md`);
  }

  async save(profile: PersonProfile, action: ProfileAction = "create"): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const filePath = this.file(profile.meta.slug);
    if (action === "create" && fs.existsSync(filePath)) {
      throw new Error(`profile already exists: ${profile.meta.slug}`);
    }
    await fs.promises.writeFile(filePath, serializeProfile(profile), "utf-8");
  }

  async load(slug: string): Promise<PersonProfile | null> {
    const filePath = this.file(slug);
    if (!fs.existsSync(filePath)) return null;
    return parseProfile(await fs.promises.readFile(filePath, "utf-8"));
  }

  async listAll(): Promise<PersonProfile[]> {
    if (!fs.existsSync(this.dir)) return [];
    const out: PersonProfile[] = [];
    for (const f of await fs.promises.readdir(this.dir)) {
      if (!f.endsWith(".md")) continue;
      const parsed = parseProfile(await fs.promises.readFile(path.join(this.dir, f), "utf-8"));
      if (parsed) out.push(parsed);
    }
    return out;
  }

  async findByName(nameOrAlias: string): Promise<PersonProfile | null> {
    const all = await this.listAll();
    return all.find((p) => p.meta.canonicalName === nameOrAlias || p.meta.aliases.includes(nameOrAlias)) ?? null;
  }

  async listRecent(limit: number): Promise<PersonProfile[]> {
    const all = await this.listAll();
    return all.sort((a, b) => b.meta.lastSeen.localeCompare(a.meta.lastSeen)).slice(0, limit);
  }
}
