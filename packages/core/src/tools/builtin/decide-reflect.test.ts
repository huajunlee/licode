// packages/core/src/tools/builtin/decide-reflect.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildReflectPrompt,
  parseReflectResponse,
  formatVerdictText,
  decideReflectTool,
  _setReflectChat,
  _setReflectTimeout,
} from "./decide-reflect.js";

beforeEach(() => {
  _setReflectChat(null);
  _setReflectTimeout(null);
});

describe("buildReflectPrompt", () => {
  it("含评估 rubric 与输出格式要求", () => {
    const p = buildReflectPrompt("# 决策计划：x\n## 维度\n- 成长：…");
    expect(p).toContain("关键维度缺失");
    expect(p).toContain("passed");
    expect(p).toContain("## 计划");
  });
});

describe("parseReflectResponse", () => {
  it("通过 JSON -> passed=true", () => {
    const v = parseReflectResponse('{"passed":true,"gaps":[],"suggestions":[]}');
    expect(v.passed).toBe(true);
    expect(v.gaps).toEqual([]);
  });
  it("不通过 JSON -> passed=false + gaps/suggestions", () => {
    const v = parseReflectResponse('{"passed":false,"gaps":["缺风险维度"],"suggestions":["加风险"]}');
    expect(v.passed).toBe(false);
    expect(v.gaps).toContain("缺风险维度");
    expect(v.suggestions).toContain("加风险");
  });
  it("非 JSON -> 默认通过（不阻塞 loop）", () => {
    const v = parseReflectResponse("无法解析的文本");
    expect(v.passed).toBe(true);
  });
});

describe("formatVerdictText", () => {
  it("通过 -> 含「评估通过」", () => {
    expect(formatVerdictText({ passed: true, gaps: [], suggestions: [] })).toContain("评估通过");
  });
  it("不通过 -> 含「评估未通过」与 gaps", () => {
    const t = formatVerdictText({ passed: false, gaps: ["缺风险维度"], suggestions: [] });
    expect(t).toContain("评估未通过");
    expect(t).toContain("缺风险维度");
  });
});

describe("decideReflectTool execute", () => {
  it("LLM 判不通过 -> metadata.passed=false，content 含 gaps", async () => {
    _setReflectChat(async () => '{"passed":false,"gaps":["缺风险维度"],"suggestions":["加风险"]}');
    const res = await decideReflectTool.execute(
      { plan: "# 决策计划：换工作\n## 维度\n- 成长：…" },
      { workingDirectory: ".", sessionId: "s" }
    );
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.metadata).toMatchObject({ passed: false, gaps: ["缺风险维度"] });
      expect(res.content).toContain("缺风险维度");
    }
  });
  it("LLM 判通过 -> metadata.passed=true", async () => {
    _setReflectChat(async () => '{"passed":true,"gaps":[],"suggestions":[]}');
    const res = await decideReflectTool.execute(
      { plan: "# 决策计划：x" },
      { workingDirectory: ".", sessionId: "s" }
    );
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.metadata).toMatchObject({ passed: true });
  });
  it("LLM 抛错 -> status=error", async () => {
    _setReflectChat(async () => { throw new Error("boom"); });
    const res = await decideReflectTool.execute(
      { plan: "# 决策计划：x" },
      { workingDirectory: ".", sessionId: "s" }
    );
    expect(res.status).toBe("error");
  });
  it("LLM 挂起 -> 超时后 status=error（远小于生产 10s）", async () => {
    // 注入永不 resolve 的 chat + 短超时，避免测试等待 10s
    _setReflectChat(() => new Promise<string>(() => {}));
    _setReflectTimeout(50);
    const start = Date.now();
    const res = await decideReflectTool.execute(
      { plan: "# 决策计划：x" },
      { workingDirectory: ".", sessionId: "s" }
    );
    const elapsed = Date.now() - start;
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.errorType).toBe("execution");
    expect(elapsed).toBeLessThan(2000);
  });
  it("description 限定仅 decide_plan 后调用", () => {
    expect(decideReflectTool.description).toContain("decide_plan");
  });
});
