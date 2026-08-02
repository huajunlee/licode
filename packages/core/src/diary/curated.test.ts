import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CuratedIndex } from "./curated.js";

describe("CuratedIndex", () => {
  let file: string;
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cur-")), ".curated.json"); });
  afterEach(() => { fs.rmSync(path.dirname(file), { recursive: true, force: true }); });

  it("load on missing file returns empty set", async () => {
    const idx = new CuratedIndex(file);
    expect((await idx.load()).size).toBe(0);
  });

  it("mark persists keys and load reads them back", async () => {
    const idx = new CuratedIndex(file);
    await idx.mark(["e1#c0", "e1#p1"]);
    const loaded = await idx.load();
    expect(loaded.has("e1#c0")).toBe(true);
    expect(loaded.has("e1#p1")).toBe(true);
    expect(loaded.has("e1#c9")).toBe(false);
  });

  it("mark is idempotent and additive", async () => {
    const idx = new CuratedIndex(file);
    await idx.mark(["e1#c0"]);
    await idx.mark(["e1#c0", "e1#c1"]);
    const loaded = await idx.load();
    expect(loaded.size).toBe(2);
  });
});
