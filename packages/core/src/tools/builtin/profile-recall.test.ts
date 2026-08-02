import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { profileRecallTool } from "./profile-recall.js";
import { PersonProfileStore } from "../../people/store.js";
import { emptyProfile } from "../../people/types.js";
import { toSlug } from "../../memory/types.js";

describe("profileRecallTool", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "prec-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function seed() {
    const store = new PersonProfileStore(path.join(dir, ".licode", "people"));
    const p = emptyProfile("王总", "2026-08-01");
    p.meta.slug = toSlug("王总");
    p.meta.aliases = ["老板"];
    p.summary = "上级";
    p.traits = ["果断"];
    await store.save(p, "create");
  }
  const ctx = () => ({ workingDirectory: dir, sessionId: "test" } as any);

  it("returns a profile by name", async () => {
    await seed();
    const res = await profileRecallTool.execute({ name: "王总" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("王总");
      expect(res.content).toContain("果断");
    }
  });

  it("returns a profile by alias", async () => {
    await seed();
    const res = await profileRecallTool.execute({ name: "老板" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("王总");
  });

  it("returns not-found message when no match", async () => {
    const res = await profileRecallTool.execute({ name: "不存在" }, ctx());
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("没有找到");
  });
});
