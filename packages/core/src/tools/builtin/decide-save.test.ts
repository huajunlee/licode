import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildDecisionEntry } from "./decide-save.js";
import { serializeEntry, parseEntry } from "../../diary/serialize.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideSaveTool } from "./decide-save.js";
import { JournalStore } from "../../diary/store.js";

const NOW = () => new Date("2026-08-01T10:00:00.000Z");

describe("buildDecisionEntry", () => {
  it("产出正确 meta（id 为 base36 时间戳）、title 标记、decisions、summary", () => {
    const e = buildDecisionEntry({ topic: "换工作", decision: "先不动", reasoning: "等年终", now: NOW });
    expect(e.meta.id).toBe(NOW().getTime().toString(36));
    expect(e.meta.date).toBe("2026-08-01");
    expect(e.title).toBe("【决策】换工作");
    expect(e.summary).toBe("先不动");
    expect(e.decisions).toEqual([{ decision: "先不动", reasoning: "等年终", context: "换工作" }]);
  });

  it("people 映射为 PersonRef", () => {
    const e = buildDecisionEntry({ topic: "t", decision: "d", reasoning: "r", people: ["王总", "李四"], now: NOW });
    expect(e.people).toEqual([
      { name: "王总", relation: null, relationInferred: false, interaction: "决策涉及", note: null, specific: true },
      { name: "李四", relation: null, relationInferred: false, interaction: "决策涉及", note: null, specific: true },
    ]);
  });

  it("futureMemory 为空（gating）", () => {
    const e = buildDecisionEntry({ topic: "t", decision: "d", reasoning: "r", now: NOW });
    expect(e.futureMemory).toEqual([]);
  });

  it("round-trip：serialize -> parse 关键字段保持", () => {
    const e = buildDecisionEntry({ topic: "换工作", decision: "先不动", reasoning: "等年终奖", people: ["王总"], now: NOW });
    const parsed = parseEntry(serializeEntry(e))!;
    expect(parsed).not.toBeNull();
    expect(parsed.meta.id).toBe(e.meta.id);
    expect(parsed.meta.date).toBe("2026-08-01");
    expect(parsed.title).toBe("【决策】换工作");
    expect(parsed.summary).toBe("先不动");
    expect(parsed.decisions[0]).toEqual({ decision: "先不动", reasoning: "等年终奖", context: "换工作" });
    expect(parsed.people[0].name).toBe("王总");
    expect(parsed.futureMemory).toEqual([]);
    expect(parsed.raw.content).toContain("先不动");
  });
});

describe("decideSaveTool execute", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsave-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("写入 journal 且能读回", async () => {
    const res = await decideSaveTool.execute(
      { topic: "换工作", decision: "先不动", reasoning: "等年终" },
      { workingDirectory: dir, sessionId: "s" }
    );
    expect(res.status).toBe("success");
    if (res.status === "success") {
      const meta = res.metadata as { id: string; date: string };
      const store = new JournalStore(path.join(dir, ".licode", "journal"));
      const loaded = await store.load(meta.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.decisions[0].decision).toBe("先不动");
      expect(loaded!.title).toBe("【决策】换工作");
    }
  });

  it("gating：不产生 memory 文件", async () => {
    await decideSaveTool.execute(
      { topic: "换工作", decision: "先不动", reasoning: "等年终" },
      { workingDirectory: dir, sessionId: "s" }
    );
    expect(fs.existsSync(path.join(dir, ".licode", "memory"))).toBe(false);
  });
});
