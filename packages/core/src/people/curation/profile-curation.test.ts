import { describe, it, expect } from "vitest";
import { ProfileCuration } from "./profile-curation.js";
import type { PendingPerson } from "../../curation/types.js";
import { emptyProfile } from "../types.js";
import type { PersonRef } from "../../diary/types.js";

function pp(key: string, name: string): PendingPerson {
  const ref: PersonRef = { name, relation: "上级", relationInferred: false, interaction: "开会", note: "爱喝茶", specific: false };
  return { key, personRef: ref, date: "2026-08-01", entryId: "e1" };
}

describe("ProfileCuration.resolveAmbiguous", () => {
  it("proposes merge when a name clusters to an existing profile", async () => {
    const generate = async () => JSON.stringify([
      { action: "merge", index: 0, intoSlug: "wang", reason: "都是上级/工作场景" },
    ]);
    const c = new ProfileCuration({ generate });
    const profiles = [emptyProfile("王总", "2026-07-30")];
    profiles[0].meta.slug = "wang";
    profiles[0].meta.aliases = ["老板"];
    const out = await c.resolveAmbiguous([pp("e1#p0", "老王")], profiles);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("profile-merge");
    expect((out[0] as { intoSlug: string }).intoSlug).toBe("wang");
    expect((out[0] as { sourceKeys: string[] }).sourceKeys).toEqual(["e1#p0"]);
  });

  it("proposes new when no existing profile matches", async () => {
    const generate = async () => JSON.stringify([
      { action: "new", index: 0, name: "李四", reason: "新人物" },
    ]);
    const c = new ProfileCuration({ generate });
    const out = await c.resolveAmbiguous([pp("e1#p0", "朋友")], []);
    expect(out[0].kind).toBe("profile-new");
    expect((out[0] as { name: string }).name).toBe("李四");
  });

  it("returns [] on side-call failure (skip)", async () => {
    const generate = async () => { throw new Error("net"); };
    const c = new ProfileCuration({ generate });
    expect(await c.resolveAmbiguous([pp("e1#p0", "朋友")], [])).toEqual([]);
  });
});
