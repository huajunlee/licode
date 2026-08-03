// packages/core/src/tools/builtin/decide-plan.ts
import { z } from "zod";
import type { Tool } from "../types.js";

const Dimension = z.object({
  aspect: z.string().describe("维度，如「成长」「薪酬」「风险」"),
  goal: z.string().describe("具体评估目标，如「未来3年技术成长空间」"),
});

const Person = z.object({
  name: z.string().describe("人名"),
  relation: z.string().describe("与用户的关系，如「上级」「朋友」「家人」"),
});

export const DecidePlanParams = z.object({
  topic: z.string().describe("决策话题关键词，用于 recall 匹配（如「换工作」）"),
  question: z.string().describe("完整决策问题/处境描述，是 topic 的详细补充"),
  dimensions: z.array(Dimension).min(1).describe("需权衡的维度 + 具体评估目标"),
  options: z.array(z.string()).min(2).describe("可行选项"),
  steps: z.array(z.string()).min(1).describe("执行步骤，每步说明要召回/收集什么（如 journal_recall(\"职业 历史\")）"),
  focus: z.string().optional().describe("升级或反思修订时需深挖的维度/遗漏"),
  people: z.array(Person).optional().describe("相关人 + 关系"),
});

export interface PlanInput {
  topic: string;
  question: string;
  dimensions: { aspect: string; goal: string }[];
  options: string[];
  steps: string[];
  focus?: string;
  people?: { name: string; relation: string }[];
}

/** 把结构化入参渲染成计划 markdown（纯函数，便于测试）。 */
export function renderPlan(input: PlanInput): string {
  const lines: string[] = [`# 决策计划：${input.topic}`];
  lines.push("## 决策问题", input.question);
  if (input.focus) lines.push("## 本次重点", input.focus);
  lines.push("## 维度");
  for (const d of input.dimensions) lines.push(`- ${d.aspect}：${d.goal}`);
  lines.push("## 选项");
  input.options.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
  if (input.people?.length) {
    lines.push("## 相关人物");
    for (const p of input.people) lines.push(`- ${p.name}（${p.relation}）`);
  }
  lines.push("## 执行步骤");
  input.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  return lines.join("\n");
}

export const decidePlanTool: Tool<typeof DecidePlanParams> = {
  name: "decide_plan",
  description:
    "复杂决策的规划工具。当决策命中任一条件时调用（而非 decide）：多维度权衡（2+ 竞争维度）/ 高 stakes 难撤销（职业、大额支出、重大关系）/ 信息不足需跨多主题人物定向召回 / 多选项（3+）/ 长影响周期（月/年级）。" +
    "调用时由你（主模型）直接填写结构化计划（topic 关键词、question 完整问题、dimensions 维度+评估目标、options 选项、steps 执行步骤、可选 focus/people）。" +
    "产出计划后，必须调用 decide_reflect 评估；若 decide_reflect 返回 passed=false，用 focus=gaps+suggestions 修订重评，最多 2 轮；通过或达上限后才内联执行 steps。" +
    "执行完 steps 后按 B 式（2-3 路径+利弊+倾向建议）或 C 式（证据不足则摆事实、交还判断权）给出综合分析，并询问是否调用 decide_save 保存。简单决策（二选一、低 stakes、当前上下文够用）用 decide。",
  parameters: DecidePlanParams,
  async execute(input) {
    // zod min() 已校验 dimensions>=1 / options>=2 / steps>=1；
    // 非法入参在 executor 的 safeParse 阶段就被挡回 errorType:"validation"。
    const content = renderPlan(input);
    return {
      status: "success",
      content,
      metadata: {
        dimensions: input.dimensions.length,
        options: input.options.length,
        steps: input.steps.length,
      },
    };
  },
};
