/**
 * 端到端运行实录：把「模型的每一步输出」和「每一次工具调用」按时间顺序完整落盘。
 *
 * 与 e2e-verify.mjs 的区别：那个按事件总线记工具调用、只保留最终回答；
 * 这个直接遍历对话消息，所以能拿到 thinking、tool_use 之前/之后的正文，
 * 以及工具结果与调用的一一对应（走后面的 tool_result 消息配对）。
 *
 * 用法：必须让进程 cwd == 工作区（工具的工作目录取自 process.cwd()）
 *   cd decide-test-workspace && node ../decide-test-scripts/e2e-transcript.mjs
 */
import * as fs from "node:fs";
import { initializeConversationRuntime } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/cli/dist/cli.js";
import { AgentLoop } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/agent/loop.js";

const cwd = "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/decide-test-workspace";
const model = process.env.ANTHROPIC_MODEL || "deepseek-v4-flash";
const OUT = "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/decide-skill-test-run-after-fix.md";

// 工具结果可能很长（读 SKILL.md、搜网页），给足余量但设上限
const RESULT_LIMIT = 4000;
const TEXT_LIMIT = 6000;

if (process.cwd() !== cwd) {
  console.error(`❌ 进程 cwd (${process.cwd()}) 必须等于工作区 (${cwd})`);
  console.error(`   先 cd 过去再跑`);
  process.exit(1);
}

const RUNS = [
  {
    label: "A. 个人决策",
    question: "我爸妈一直想让我回老家考公务员，但我更想留在大城市做技术。我该听他们的吗？",
  },
  {
    label: "B. 外部事实",
    question: "帮我查一下 DeepSeek V4 现在的 API 定价是多少，我最近在算成本。",
  },
];

const out = [];
const w = (s = "") => out.push(s);

function clip(text, limit) {
  const t = String(text ?? "");
  if (t.length <= limit) return t;
  return `${t.slice(0, limit)}\n…（原文 ${t.length} 字符，此处截断）`;
}

/** 把一段文本渲染成引用块，避免和 markdown 结构混淆 */
function quote(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

w("# decide 技能端到端测试记录（修复后）");
w();
w("- 日期：2026-09-13");
w(`- 模型：\`${model}\``);
w(`- 工作区：\`decide-test-workspace/\`（真实数据：人物档案 1 份、日记 8 天、长期记忆 4 条）`);
w("- 本轮修复：thinking 块回传、日记搜索分词、Bash 失败保留 stdout、工作目录提示层、");
w("  memory_recall 错误区分、人物档案 frontmatter、钩子 EPIPE");
w();
w("本文件是**原始运行实录**：按时间顺序记录模型的每一步输出（含思考）与每一次工具调用。");
w("分析性结论见 `test-summary.md`。");
w();
w("---");
w();

for (const run of RUNS) {
  const rt = await initializeConversationRuntime({
    cwd,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model,
  });

  const errors = [];
  const eventBus = {
    emit(e) {
      if (e.type === "error") errors.push(`LLM 错误：${e.error?.message ?? e.error}`);
      if (e.type === "agent-loop-terminated") errors.push(`循环终止：${e.reason}`);
    },
  };

  const loop = new AgentLoop({ llm: rt.provider, conversation: rt.manager, tools: rt.tools, eventBus });

  const t0 = Date.now();
  let result;
  try {
    result = await loop.run(run.question);
  } catch (err) {
    errors.push(`抛出：${err.message}`);
    result = { messages: rt.manager.getMessages() };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const messages = [...result.messages];

  w(`# ${run.label}`);
  w();
  w(`**问题**：${run.question}`);
  w();
  w(`**耗时**：${elapsed}s　|　**消息数**：${messages.length}`);
  w();
  if (errors.length) {
    w("**运行期错误：**");
    errors.forEach((e) => w(`- ${clip(e, 300)}`));
    w();
  }

  // ---- 调用序列概览 ----
  const toolNames = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) toolNames.push(b.name);
    }
  }
  w(`**调用序列**：\`${toolNames.join(" → ")}\``);
  w();
  w("---");
  w();

  // ---- 逐步转录 ----
  let step = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "user" && typeof m.content === "string") {
      // 首条是问题本身，已在上面写过
      if (i === 0) continue;
      step++;
      w(`## 第 ${step} 步`);
      w();
      w("### 用户");
      w();
      w(quote(clip(m.content, TEXT_LIMIT)));
      w();
      continue;
    }

    if (m.role === "user" && Array.isArray(m.content)) {
      // tool_result 批：与上一条 assistant 的 tool_use 按序配对
      const prev = messages[i - 1];
      const prevUses =
        prev && prev.role === "assistant" && Array.isArray(prev.content) ? prev.content : [];
      w("### 工具结果");
      w();
      m.content.forEach((r, k) => {
        const name = prevUses[k]?.name ?? "?";
        w(`**\`${name}\` 返回${r.is_error ? "（错误）" : ""}：**`);
        w();
        w("```");
        w(clip(r.content, RESULT_LIMIT));
        w("```");
        w();
      });
      continue;
    }

    if (m.role === "assistant") {
      step++;
      w(`## 第 ${step} 步`);
      w();

      // 思考
      if (Array.isArray(m.thinking) && m.thinking.length) {
        w("### 模型思考");
        w();
        m.thinking.forEach((t, k) => {
          if (m.thinking.length > 1) w(`**（思考块 ${k + 1}）**`);
          w(quote(clip(t.thinking, TEXT_LIMIT)));
          w();
        });
      }

      // 工具调用分支：正文在 m.text，调用在 m.content
      if (Array.isArray(m.content)) {
        if (m.text) {
          w("### 模型输出（调用工具前）");
          w();
          w(quote(clip(m.text, TEXT_LIMIT)));
          w();
        }
        w("### 工具调用");
        w();
        m.content.forEach((b) => {
          w(`**\`${b.name}\`**`);
          w();
          w("```json");
          w(JSON.stringify(b.input, null, 2));
          w("```");
          w();
        });
      } else {
        // 最终文本回答
        w("### 模型输出（最终回答）");
        w();
        w(quote(clip(m.content, TEXT_LIMIT)));
        w();
      }
      continue;
    }
  }

  // ---- 最终回答摘要 ----
  const last = [...messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");
  w("---");
  w();
  w("## 最终回答是否为空");
  w();
  w(last && last.content ? `否（${last.content.length} 字符）` : "**是**");
  w();
  w("---");
  w();

  await rt.extensions.shutdown();
}

fs.writeFileSync(OUT, out.join("\n"), "utf-8");
console.log(`已写入: ${OUT}`);
console.log(`共 ${out.length} 行, ${out.join("\n").length} 字符`);
