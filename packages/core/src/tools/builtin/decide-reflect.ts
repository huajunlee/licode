// packages/core/src/tools/builtin/decide-reflect.ts
import { z } from "zod";
import type { Tool } from "../types.js";
import { AnthropicProvider } from "../../llm/anthropic.js";
import type { Message } from "../../llm/provider.js";

const REFLECT_MODEL = "deepseek-chat";

const DecideReflectParams = z.object({
  plan: z.string().describe("待评估的计划文本（decide_plan 的渲染输出，含 question/dimensions/options/steps/people）"),
});

export type ReflectVerdict = {
  passed: boolean;
  gaps: string[];
  suggestions: string[];
};

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
