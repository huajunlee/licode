import type { LLMProvider, Message } from "../llm/provider.js";
import type { Skill } from "../extensions/skills/loader.js";

/**
 * 交付前改写：用另一个技能（polishWith 指定的那个）的规则，把最终回答重写一遍。
 *
 * 为什么由 harness 兜底而不是写在技能正文里"请模型记得改写"：
 * 技能正文只是提示，模型可以跳过。而这里是在 AgentLoop 交付最终文本之前
 * 强制插入的一步——模型没有机会跳过它。
 *
 * 改写在**独立上下文**里进行：只给写作规则 + 草稿，不带对话历史。
 * 这样改写者不会替自己刚才的措辞辩护，只会照规则动手。
 */

export interface PolishOptions {
  /** 声明了 polishWith 的技能（提供规则正文） */
  skill: Skill;
  llm: LLMProvider;
  model: string;
  draft: string;
  signal?: AbortSignal;
}

/** 草稿为空或规则缺失时没什么可改的 */
export function shouldPolish(skill: Skill | undefined, draft: string): boolean {
  return Boolean(skill?.polishBody && draft.trim());
}

function buildMessages(rules: string, draft: string): Message[] {
  return [
    {
      role: "system",
      content:
        `${rules}\n\n` +
        `---\n\n` +
        `下面是需要改写的文字。按上面的规则在原稿上编辑，把它改写成可直接交付给用户的版本。\n` +
        `只输出改写后的正文，不要加任何说明、前言、评价或"改写说明"。\n` +
        `它可能是对用户的完整回答，因此保留其中的事实、数字、条件、判断与责任归属。`,
    },
    { role: "user", content: draft, timestamp: new Date().toISOString() },
  ];
}

export async function polishAnswer(opts: PolishOptions): Promise<string> {
  const { skill, llm, model, draft, signal } = opts;
  const rules = skill.polishBody!;
  const messages = buildMessages(rules, draft);

  // 改写是机械编辑，不需要扩展思考。而思考会吃光 max_tokens 让正文一个字都出不来
  // （实测：默认模式下 667 token 预算全花在思考上、正文 0 字；关掉后 37 token 出 62 字）。
  const attempts: Array<{ label: string; extensions?: Record<string, unknown>; maxTokens: number }> = [
    {
      label: "关思考",
      extensions: { thinking: { type: "disabled" } },
      maxTokens: Math.min(Math.ceil(draft.length * 1.5) + 512, 8192),
    },
    {
      // 兜底：端点不认 thinking.disabled 时退回默认，预算给足让思考也装得下
      label: "默认+大预算",
      maxTokens: Math.min(draft.length * 2 + 8192, 32768),
    },
  ];

  for (const attempt of attempts) {
    try {
      const ext = { ...(attempt.extensions ?? {}), ...(signal ? { signal } : {}) };
      const res = await llm.chat({
        model,
        messages,
        maxTokens: attempt.maxTokens,
        ...(Object.keys(ext).length ? { extensions: ext } : {}),
      });
      const out = (res.content ?? "").trim();

      if (process.env.LICODE_POLISH_DEBUG) {
        console.error(
          `[polish] ${attempt.label} 规则=${rules.length}字 草稿=${draft.length}字 ` +
            `maxTokens=${attempt.maxTokens} → stop=${res.stopReason} out=${res.usage.output}tok 正文=${out.length}字`
        );
      }

      if (out) return out;
    } catch (err) {
      if (process.env.LICODE_POLISH_DEBUG) {
        console.error(`[polish] ${attempt.label} 失败：${(err as Error).message}`);
      }
    }
  }

  // 两道都拿不到正文时保留原稿——宁可交付没润色的答案，也不能交付空答案
  return draft;
}
