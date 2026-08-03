// packages/core/src/tools/builtin/decide-plan.test.ts
import { describe, it, expect } from "vitest";
import { renderPlan, decidePlanTool, DecidePlanParams } from "./decide-plan.js";

const baseInput = {
  topic: "换工作",
  question: "是否接受创业公司X的后端offer，当前在Y公司稳定但天花板低",
  dimensions: [{ aspect: "成长", goal: "未来3年技术成长空间" }],
  options: ["接受", "拒绝"],
  steps: ['journal_recall("职业 历史")'],
};

describe("renderPlan", () => {
  it("含决策问题、维度(aspect:goal)、选项、步骤", () => {
    const out = renderPlan(baseInput);
    expect(out).toContain("# 决策计划：换工作");
    expect(out).toContain("是否接受创业公司X的后端offer");
    expect(out).toContain("- 成长：未来3年技术成长空间");
    expect(out).toContain("1. 接受");
    expect(out).toContain('1. journal_recall("职业 历史")');
  });
  it("focus 提供时进「本次重点」段", () => {
    const out = renderPlan({ ...baseInput, focus: "漏了家庭维度" });
    expect(out).toContain("## 本次重点");
    expect(out).toContain("漏了家庭维度");
  });
  it("people 渲染为「名字（关系）」", () => {
    const out = renderPlan({ ...baseInput, people: [{ name: "张三", relation: "上级" }] });
    expect(out).toContain("## 相关人物");
    expect(out).toContain("- 张三（上级）");
  });
  it("无 focus/people 时不出现对应段", () => {
    const out = renderPlan(baseInput);
    expect(out).not.toContain("## 本次重点");
    expect(out).not.toContain("## 相关人物");
  });
});

describe("DecidePlanParams 校验", () => {
  it("options < 2 不通过", () => {
    expect(DecidePlanParams.safeParse({ ...baseInput, options: ["only"] }).success).toBe(false);
  });
  it("空 dimensions 不通过", () => {
    expect(DecidePlanParams.safeParse({ ...baseInput, dimensions: [] }).success).toBe(false);
  });
  it("空 steps 不通过", () => {
    expect(DecidePlanParams.safeParse({ ...baseInput, steps: [] }).success).toBe(false);
  });
  it("合法入参通过", () => {
    expect(DecidePlanParams.safeParse(baseInput).success).toBe(true);
  });
});

describe("decidePlanTool execute", () => {
  it("返回 success + 计划文本 + 计数 metadata", async () => {
    const res = await decidePlanTool.execute(baseInput, { workingDirectory: ".", sessionId: "s" });
    expect(res.status).toBe("success");
    if (res.status === "success") {
      expect(res.content).toContain("# 决策计划：换工作");
      expect(res.metadata).toEqual({ dimensions: 1, options: 2, steps: 1 });
    }
  });
  it("description 含路由 rubric 与 loop 指引", () => {
    expect(decidePlanTool.description).toContain("多维度权衡");
    expect(decidePlanTool.description).toContain("decide_reflect");
    expect(decidePlanTool.description).toContain("最多 2 轮");
  });
});
