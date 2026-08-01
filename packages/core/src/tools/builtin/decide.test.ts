// packages/core/src/tools/builtin/decide.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gatherDecisionContext } from "./decide.js";
import { emptyEntry } from "../../diary/types.js";
import { emptyProfile } from "../../people/types.js";
import type { DiaryEntry } from "../../diary/types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideTool } from "./decide.js";
import { JournalStore } from "../../diary/store.js";

function entry(id: string, date: string, opts: Partial<DiaryEntry> = {}): DiaryEntry {
  const e = emptyEntry(id, date, `${date}T10:00:00.000Z`);
  Object.assign(e, opts);
  return e;
}

describe("gatherDecisionContext", () => {
  it("话题子串命中含 decisions 的 entry（验证搜了 decisions 字段）", () => {
    const e = entry("e1", "2026-07-30", {
      summary: "今天的事",
      decisions: [{ decision: "决定换架构", reasoning: "旧架构维护成本高", context: null }],
    });
    // summary 不含"换架构"，只有 decisions 含 -> 命中证明搜了 decisions
    const out = gatherDecisionContext({ entries: [e], profiles: [], topic: "换架构" });
    expect(out).toContain("决定换架构");
    expect(out).toContain("旧架构维护成本高");
  });

  it("无话题匹配时兜底近期决定", () => {
    const e = entry("e1", "2026-07-30", {
      decisions: [{ decision: "决定暂缓跳槽", reasoning: "等年终", context: null }],
    });
    const out = gatherDecisionContext({ entries: [e], profiles: [], topic: "换城市" });
    expect(out).toContain("无直接匹配");
    expect(out).toContain("决定暂缓跳槽");
  });

  it("people 参数与匹配 entry 里提到的人 -> 档案进结果", () => {
    const li = emptyProfile("李四", "2026-07-01"); li.summary = "同事";
    const zhao = emptyProfile("赵六", "2026-07-01"); zhao.summary = "朋友";
    const e1 = entry("e1", "2026-07-30", {
      summary: "聊换工作",
      people: [{ name: "赵六", relation: null, relationInferred: false, interaction: "聊", note: null, specific: true }],
    });
    const out = gatherDecisionContext({ entries: [e1], profiles: [li, zhao], topic: "换工作", people: ["李四"] });
    expect(out).toContain("李四");
    expect(out).toContain("赵六");
  });

  it("topic 直接提到的人名 -> 档案进结果", () => {
    const wang = emptyProfile("王总", "2026-07-01"); wang.meta.aliases = ["老板"]; wang.summary = "上级";
    const out = gatherDecisionContext({ entries: [], profiles: [wang], topic: "王总" });
    expect(out).toContain("王总");
  });

  it("最近 5 条 entry 摘要进近期日记", () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`e${i}`, `2026-07-2${i}`));
    const out = gatherDecisionContext({ entries, profiles: [], topic: "zzz无匹配" });
    const recentSection = out.split("## 近期日记")[1];
    expect(recentSection.split("\n").filter((l) => l.startsWith("- [")).length).toBe(5);
  });

  it("空 entries 优雅且 framing 仍在", () => {
    const out = gatherDecisionContext({ entries: [], profiles: [], topic: "换工作" });
    expect(out).toContain("暂无与该话题直接相关的历史决定");
    expect(out).toContain("## 分析指引");
  });

  it("B/C framing 文案在输出中", () => {
    const out = gatherDecisionContext({ entries: [], profiles: [], topic: "x" });
    expect(out).toContain("B 式");
    expect(out).toContain("降级 C");
    expect(out).toContain("必须询问");
    expect(out).toContain("decide_save");
  });
});

describe("decideTool execute", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "decide-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("从 workingDirectory 加载 store 并返回上下文", async () => {
    const store = new JournalStore(path.join(dir, ".licode", "journal"));
    const e = emptyEntry("e1", "2026-07-30", "2026-07-30T10:00:00.000Z");
    e.decisions = [{ decision: "决定换架构", reasoning: "贵", context: null }];
    await store.save(e);

    const res = await decideTool.execute({ topic: "换架构" }, { workingDirectory: dir, sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("决定换架构");
  });

  it("空目录返回 success 且含暂无提示", async () => {
    const res = await decideTool.execute({ topic: "换工作" }, { workingDirectory: dir, sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.content).toContain("暂无");
  });

  it("store 读错时返回 error", async () => {
    fs.mkdirSync(path.join(dir, ".licode"));
    fs.writeFileSync(path.join(dir, ".licode", "journal"), "x"); // journal 是文件而非目录 -> readdir 抛错
    const res = await decideTool.execute({ topic: "x" }, { workingDirectory: dir, sessionId: "s" });
    expect(res.status).toBe("error");
  });
});
