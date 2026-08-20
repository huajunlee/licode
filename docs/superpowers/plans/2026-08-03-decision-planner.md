# 决策 Planner 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为复杂决策新增 `decide_plan`（模型自写计划）+ `decide_reflect`（side-call LLM 评估）两个工具，构成 reflect-revise 收敛循环（最多 2 轮），并在 TUI 半透明展开计划/评估。

**Architecture:** P1 模型自写计划（`decide_plan` 的 execute 仅校验+渲染，无 side-call）；`decide_reflect` 自建 `AnthropicProvider`（同 `recall.ts` 模式）做 temperature:0 side-call 评估，返回 `{passed, gaps, suggestions}`；loop 由主模型驱动（复用 agent loop 多轮工具调用），不新增执行引擎；TUI 对这两个工具的 done 结果完整展开（绕过 40 列截断）。

**Tech Stack:** TypeScript ^5.7、zod（参数 schema）、vitest ^3、ink（TUI）、Node >=20。

## Global Constraints

- 工具实现 `Tool<TParams>` 接口（`packages/core/src/tools/types.ts`）：`{ name; description; parameters: zod; execute(input, context): Promise<ToolResult> }`。`ToolResult = {status:"success"; content; metadata?} | {status:"error"; error; errorType:"validation"|"execution"|"timeout"}`。
- `ToolContext = { workingDirectory; sessionId; signal?; sandbox? }`，不含 LLM。`decide_reflect` 需 side-call 时**自建** `AnthropicProvider`（读 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` 环境变量），不修改 `ToolContext`。
- side-call 模型用 `"deepseek-chat"`（同 `recall.ts`），`temperature: 0`。
- 工具注册在 `packages/core/src/tools/builtin/index.ts` 的 `builtinTools` 数组 + 导出。
- `docs/superpowers/` 在 `.git/info/exclude` 中被忽略，提交 spec/plan 需 `git add -f`。
- 提交信息用 conventional commits：`feat(planner): ...` / `feat(tui): ...`。
- 中文文案、注释风格对齐现有 `decide.ts` / `journal-recall.ts`。

---

## File Structure

- **Create** `packages/core/src/tools/builtin/decide-plan.ts` — `decide_plan` 工具 + 纯函数 `renderPlan`
- **Create** `packages/core/src/tools/builtin/decide-plan.test.ts` — 测试
- **Create** `packages/core/src/tools/builtin/decide-reflect.ts` — `decide_reflect` 工具 + 纯函数 `buildReflectPrompt`/`parseReflectResponse`/`formatVerdictText`
- **Create** `packages/core/src/tools/builtin/decide-reflect.test.ts` — 测试
- **Modify** `packages/core/src/tools/builtin/index.ts` — 注册两个工具
- **Modify** `packages/core/src/tools/builtin/decide.ts` — description 加「简单决策用本工具，复杂用 decide_plan」对比
- **Modify** `packages/cli/src/components/tool-line.ts` — 加 `FULL_EXPAND_TOOLS` + 纯函数 `shouldExpandFull`
- **Modify** `packages/cli/src/components/tool-line.test.ts` — 测试 `shouldExpandFull`
- **Modify** `packages/cli/src/components/tool-call-card.tsx` — done 态对 allowlist 工具完整展开 result

---

## Task 1: `decide_plan` 工具 + 路由描述

**Files:**
- Create: `packages/core/src/tools/builtin/decide-plan.ts`
- Create: `packages/core/src/tools/builtin/decide-plan.test.ts`
- Modify: `packages/core/src/tools/builtin/index.ts`
- Modify: `packages/core/src/tools/builtin/decide.ts` (description 行)

**Interfaces:**
- Consumes: `Tool`、`ToolResult`、`ToolContext` from `../types.js`；zod。
- Produces: `decidePlanTool: Tool<typeof DecidePlanParams>`、`renderPlan(input: PlanInput): string`、`DecidePlanParams`（zod schema）、`PlanInput`（类型）。后续 Task 2 的 `decide_reflect` description 引用 `decide_plan` 名字；Task 3 的 TUI allowlist 引用名字 `"decide_plan"`。

- [ ] **Step 1: 写失败测试 `decide-plan.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/src/tools/builtin/decide-plan.test.ts`
Expected: FAIL，报 `Cannot find module './decide-plan.js'`

- [ ] **Step 3: 写实现 `decide-plan.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/src/tools/builtin/decide-plan.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 注册工具 + 调整 decide 路由描述**

Modify `packages/core/src/tools/builtin/index.ts`：在 import 区加 `import { decidePlanTool } from "./decide-plan.js";`；在 `builtinTools` 数组里 `decideSaveTool` 后加 `decidePlanTool,`；在底部 `export { ... }` 行加 `decidePlanTool`。

Modify `packages/core/src/tools/builtin/decide.ts` 的 `decideTool.description`（约 145-147 行）：在末尾追加一句对比说明——
原文末尾 `…话题尽量写关键词便于匹配。` 改为：
```
…话题尽量写关键词便于匹配。仅用于简单决策（二选一、低 stakes、当前上下文够用、用户要快）；复杂决策（多维度权衡/高 stakes/需定向召回/多选项/长周期）用 decide_plan。
```

- [ ] **Step 6: 全量构建 + 测试**

Run: `pnpm build && pnpm test`
Expected: build 零错误；测试全过（含新增 decide-plan 测试）。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/tools/builtin/decide-plan.ts packages/core/src/tools/builtin/decide-plan.test.ts packages/core/src/tools/builtin/index.ts packages/core/src/tools/builtin/decide.ts
git commit -m "feat(planner): add decide_plan tool + routing"
```

---

## Task 2: `decide_reflect` 工具（side-call LLM 评估）

**Files:**
- Create: `packages/core/src/tools/builtin/decide-reflect.ts`
- Create: `packages/core/src/tools/builtin/decide-reflect.test.ts`
- Modify: `packages/core/src/tools/builtin/index.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolResult`/`ToolContext` from `../types.js`；`AnthropicProvider` from `../../llm/anthropic.js`；`Message` from `../../llm/provider.js`；zod。
- Produces: `decideReflectTool: Tool<typeof DecideReflectParams>`、`buildReflectPrompt(plan): string`、`parseReflectResponse(content): ReflectVerdict`、`formatVerdictText(v): string`、`_setReflectChat(fn|null)`（测试注入缝）。Task 3 的 TUI allowlist 引用名字 `"decide_reflect"`。

- [ ] **Step 1: 写失败测试 `decide-reflect.test.ts`**

```ts
// packages/core/src/tools/builtin/decide-reflect.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildReflectPrompt,
  parseReflectResponse,
  formatVerdictText,
  decideReflectTool,
  _setReflectChat,
} from "./decide-reflect.js";

beforeEach(() => _setReflectChat(null));

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
  it("description 限定仅 decide_plan 后调用", () => {
    expect(decideReflectTool.description).toContain("decide_plan");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/src/tools/builtin/decide-reflect.test.ts`
Expected: FAIL，报 `Cannot find module './decide-reflect.js'`

- [ ] **Step 3: 写实现 `decide-reflect.ts`**

```ts
// packages/core/src/tools/builtin/decide-reflect.ts
import { z } from "zod";
import type { Tool } from "../types.js";
import { AnthropicProvider } from "../../llm/anthropic.js";
import type { Message } from "../../llm/provider.js";

const REFLECT_MODEL = "deepseek-chat";

const DecideReflectParams = z.object({
  plan: z.string().describe("待评估的计划文本（decide_plan 的渲染输出，含 question/dimensions/options/steps/people）"),
});

export interface ReflectVerdict {
  passed: boolean;
  gaps: string[];
  suggestions: string[];
}

/** 构建评估 prompt（纯函数，便于测试）。 */
export function buildReflectPrompt(plan: string): string {
  return [
    "你是决策计划的严格评审。评估下面这份决策计划是否完备。",
    "只报实质性遗漏，不挑小毛病：",
    "1. 关键维度缺失（漏了影响决策的重要方面）",
    "2. 选项严重偏见或狭窄（没覆盖真正可行的路径）",
    "3. 步骤不可行（召回目标不明确/无法执行）",
    "4. 人物缺失（明显相关的人没列入）",
    "5. 决策问题不清晰",
    "若计划已覆盖关键点，判定通过。",
    "",
    "## 输出格式（严格 JSON，不要 markdown 代码块）",
    '通过：{"passed": true, "gaps": [], "suggestions": []}',
    '不通过：{"passed": false, "gaps": ["问题1", "问题2"], "suggestions": ["建议补的维度/选项"]}',
    "",
    "## 计划",
    plan,
  ].join("\n");
}

/** 解析 LLM 返回为结构化判定（纯函数）。非 JSON 默认通过，避免阻塞 loop。 */
export function parseReflectResponse(content: string): ReflectVerdict {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { passed: true, gaps: [], suggestions: [] };
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      passed: Boolean(obj.passed),
      gaps: Array.isArray(obj.gaps) ? obj.gaps.map(String) : [],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String) : [],
    };
  } catch {
    return { passed: true, gaps: [], suggestions: [] };
  }
}

/** 把判定渲染成人可读文本（content 字段，供主模型读后决定是否 loop）。 */
export function formatVerdictText(v: ReflectVerdict): string {
  if (v.passed) return "评估通过：计划已覆盖关键点，可执行。";
  const lines = ["评估未通过："];
  if (v.gaps.length) lines.push("问题：\n- " + v.gaps.join("\n- "));
  if (v.suggestions.length) lines.push("建议：\n- " + v.suggestions.join("\n- "));
  return lines.join("\n");
}

// --- 测试注入缝：生产为 null，走真实 AnthropicProvider ---
type ReflectChat = (prompt: string) => Promise<string>;
let testChat: ReflectChat | null = null;
/** 仅供测试：注入 chat 实现；传 null 恢复生产行为。 */
export function _setReflectChat(fn: ReflectChat | null): void {
  testChat = fn;
}

async function reflectChat(prompt: string): Promise<string> {
  if (testChat) return testChat(prompt);
  const llm = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_BASE_URL,
  });
  const messages: Message[] = [
    { role: "user", content: prompt, timestamp: new Date().toISOString() },
  ];
  const res = await llm.chat({
    messages,
    model: REFLECT_MODEL,
    temperature: 0,
    maxTokens: 1024,
  });
  return res.content;
}

export const decideReflectTool: Tool<typeof DecideReflectParams> = {
  name: "decide_reflect",
  description:
    "仅在 decide_plan 产出计划后调用，评估计划是否完备。返回 {passed, gaps, suggestions}。" +
    "passed=true 表示计划已覆盖关键点、可执行；passed=false 列出 gaps 与建议，主模型应据此修订计划（decide_plan focus=gaps+suggestions）重评，最多 2 轮，第 2 轮仍不过则接受当前计划执行。" +
    "不要在其他场景调用。",
  parameters: DecideReflectParams,
  async execute(input) {
    try {
      const raw = await reflectChat(buildReflectPrompt(input.plan));
      const verdict = parseReflectResponse(raw);
      return {
        status: "success",
        content: formatVerdictText(verdict),
        metadata: verdict,
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/src/tools/builtin/decide-reflect.test.ts`
Expected: PASS（全部用例，含注入 chat 的三种场景）

- [ ] **Step 5: 注册工具**

Modify `packages/core/src/tools/builtin/index.ts`：加 `import { decideReflectTool } from "./decide-reflect.js";`；`builtinTools` 数组加 `decideReflectTool,`（放在 `decidePlanTool` 后）；底部 `export { ... }` 加 `decideReflectTool`。

- [ ] **Step 6: 全量构建 + 测试**

Run: `pnpm build && pnpm test`
Expected: build 零错误；测试全过。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/tools/builtin/decide-reflect.ts packages/core/src/tools/builtin/decide-reflect.test.ts packages/core/src/tools/builtin/index.ts
git commit -m "feat(planner): add decide_reflect tool (side-call LLM)"
```

---

## Task 3: TUI 半透明展开 `decide_plan` / `decide_reflect` 结果

**Files:**
- Modify: `packages/cli/src/components/tool-line.ts`
- Modify: `packages/cli/src/components/tool-line.test.ts`
- Modify: `packages/cli/src/components/tool-call-card.tsx`

**Interfaces:**
- Consumes: `ToolCallState`/`ToolCallStatus` from `./tool-line.js`（现有）；`formatToolLine`/`truncate` from `./tool-line.js`；`COLORS`/`ICONS` from `../theme.js`。
- Produces: `FULL_EXPAND_TOOLS`（Set）、`shouldExpandFull(toolName, status, result): boolean`（纯函数，`tool-line.ts`）。`ToolCallCard` done 态对 allowlist 工具完整展开 `result`，其余工具行为不变。

背景：`ToolCallState.result` 持有完整未截断字符串（`hooks.ts:323-326` 直接取 `ToolResult.content`），截断只在渲染层（`formatToolLine` 40 列摘要、error 块 200 字符）。所以只改 `ToolCallCard` 渲染即可，不动事件/状态层。

- [ ] **Step 1: 写失败测试（追加到 `tool-line.test.ts`）**

在 `packages/cli/src/components/tool-line.test.ts` 末尾追加：

```ts
import { shouldExpandFull } from "./tool-line.js";

describe("shouldExpandFull", () => {
  it("decide_plan done + result -> true", () => {
    expect(shouldExpandFull("decide_plan", "done", "plan text")).toBe(true);
  });
  it("decide_reflect done + result -> true", () => {
    expect(shouldExpandFull("decide_reflect", "done", "verdict text")).toBe(true);
  });
  it("其他工具 done -> false", () => {
    expect(shouldExpandFull("decide", "done", "ctx")).toBe(false);
    expect(shouldExpandFull("bash", "done", "output")).toBe(false);
  });
  it("decide_plan 但无 result -> false", () => {
    expect(shouldExpandFull("decide_plan", "done", undefined)).toBe(false);
  });
  it("decide_plan running -> false", () => {
    expect(shouldExpandFull("decide_plan", "running", "x")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/src/components/tool-line.test.ts`
Expected: FAIL，报 `shouldExpandFull is not a function`（或 import 失败）

- [ ] **Step 3: 在 `tool-line.ts` 加 allowlist + 纯函数**

在 `packages/cli/src/components/tool-line.ts` 顶部（`STATUS_ICONS` 之前）加：

```ts
/** done 态需完整展开 result 的工具（计划/评估是多行 artifact，不能截断 40 列）。 */
export const FULL_EXPAND_TOOLS = new Set(["decide_plan", "decide_reflect"]);

/** 是否对当前工具的 done 结果做完整展开。纯函数，便于测试。 */
export function shouldExpandFull(
  toolName: string,
  status: ToolCallStatus,
  result?: string
): boolean {
  return status === "done" && FULL_EXPAND_TOOLS.has(toolName) && Boolean(result);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/src/components/tool-line.test.ts`
Expected: PASS

- [ ] **Step 5: 改 `ToolCallCard` 用 `shouldExpandFull`**

Modify `packages/core/...` —— 注意是 `packages/cli/src/components/tool-call-card.tsx`。在 import 行加 `shouldExpandFull`：

```ts
import { formatToolLine, truncate, shouldExpandFull } from "./tool-line.js";
```

把 `ToolCallCard` 函数体改为（新增 `expandFull`，抑制 summary，扩展展开块条件）：

```tsx
export function ToolCallCard({
  toolName,
  status,
  detail,
  result,
  spinnerFrame,
}: ToolCallCardProps) {
  const line = formatToolLine({ toolName, status, detail, result });
  const expandFull = shouldExpandFull(toolName, status, result);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={line.color}>{line.icon} </Text>
        <Text bold>{line.name}</Text>
        {line.detail !== "" && <Text color={COLORS.muted}>  {line.detail}</Text>}
        {status === "done" && <Text color={COLORS.success}> {ICONS.inlineOk}</Text>}
        {line.summary !== "" && !expandFull && <Text color={COLORS.muted}> {line.summary}</Text>}
        {status === "running" && (
          <Text color={COLORS.muted}> 运行中 {spinnerFrame ?? ""}</Text>
        )}
      </Box>
      {(status === "error" || expandFull) && result && (
        <Box marginLeft={4}>
          <Text color={status === "error" ? COLORS.error : COLORS.muted}>
            {status === "error" ? truncate(result, 200) : result}
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 6: 全量构建 + 测试**

Run: `pnpm build && pnpm test`
Expected: build 零错误；测试全过。

- [ ] **Step 7: 提交**

```bash
git add packages/cli/src/components/tool-line.ts packages/cli/src/components/tool-line.test.ts packages/cli/src/components/tool-call-card.tsx
git commit -m "feat(tui): expand decide_plan/decide_reflect results"
```

---

## Task 4: 集成验证 + 构建

**Files:**
- 无新文件；本任务是全量验证 + 手动 E2E。

**Interfaces:**
- Consumes: Task 1-3 全部产物（两个工具已注册、TUI 已展开）。

- [ ] **Step 1: 全量构建 + 测试**

Run: `pnpm build && pnpm test`
Expected: build 零错误；所有测试通过（含 decide-plan / decide-reflect / tool-line 新增用例）。

- [ ] **Step 2: 启动 agent 手动验证（E2E 清单）**

Run: `pnpm start`（或 `npx tsx packages/cli/bin/licode.ts`），依次验证：

1. **简单决策走 decide**：问「今晚吃面还是米饭，帮我决定」-> 期望调 `decide`（不调 decide_plan），行为与现状一致。
2. **复杂决策触发 decide_plan**：问「我该不该接受这家创业公司的 offer，薪资涨 30% 但要换城市，家里有小孩」-> 期望调 `decide_plan`，TUI 完整展开计划（含维度 aspect:goal、选项、步骤、相关人物名字（关系））。
3. **reflect loop**：decide_plan 后期望自动调 `decide_reflect`；TUI 展开评估结果。若 passed=false，期望主模型调 `decide_plan(focus=…)` 修订再 reflect（最多 2 轮）；通过后内联执行 steps（看到 journal_recall / profile_recall 调用）。
4. **升级**：先问一个简单决策拿到 decide 答案，再说「太浅了，没考虑家庭」-> 期望下一轮调 decide_plan 且 focus 含家庭。
5. **保存**：综合分析后期望模型询问是否保存；同意后调 `decide_save`。

任一项不符：记录现象，回到对应 Task 修复，不要跳过。

- [ ] **Step 3: 提交（如有修复）**

```bash
# 仅当 Step 2 发现问题并修复后才提交
git add -A
git commit -m "fix(planner): integration adjustments from E2E"
```

若无修复，本任务无需额外提交。

---

## Self-Review（plan 作者自检，已执行）

**1. Spec 覆盖：**
- spec 4.1 参数（topic/question/dimensions{aspect,goal}/options/steps/focus/people{name,relation}）-> Task 1 ✓
- spec 4.2 execute（校验+渲染+metadata 计数）-> Task 1 ✓（zod min 校验 + renderPlan + metadata.length）
- spec 4.3 综合分析指引（B/C 式 + decide_save 询问）-> Task 1 description 含 ✓
- spec 4.4 计划格式 -> Task 1 renderPlan ✓
- spec 4.5 注册 -> Task 1 Step 5 ✓
- spec 5.1 reflect loop（2 轮、focus 修订）-> Task 1 description（loop 指引）+ Task 2 description（passed/false 修订）✓
- spec 5.2 decide_reflect（side-call LLM、rubric、{passed,gaps,suggestions}）-> Task 2 ✓
- spec 5.3 注册 -> Task 2 Step 5 ✓
- spec 6 路由（decide_plan rubric、decide 对比、decide_reflect 限定）-> Task 1 description + decide.ts tweak + Task 2 description ✓
- spec 7 升级（focus）-> Task 1 focus 参数 + description 升级触发信号 ✓（行为靠 E2E）
- spec 8 TUI 展开 -> Task 3 ✓
- spec 9 保存 -> 复用 decide_save，无新代码（Task 4 E2E 验证）✓
- spec 10 测试 -> 各 Task 测试 + Task 4 全量 ✓
- spec 12 成功标准 -> Task 4 E2E 清单 ✓

**2. 占位符扫描：** 无 TBD/TODO；所有代码步骤含完整代码；测试含完整断言。

**3. 类型一致性：** `renderPlan(input: PlanInput)` 与 `decidePlanTool.execute` 入参一致；`ReflectVerdict` 在 parse/format/metadata 三处一致；`shouldExpandFull(toolName, status, result?)` 签名在 tool-line.ts 定义与 tool-line.test.ts / tool-call-card.tsx 调用一致；工具名 `"decide_plan"`/`"decide_reflect"` 在 description、index.ts、FULL_EXPAND_TOOLS 三处拼写一致。
