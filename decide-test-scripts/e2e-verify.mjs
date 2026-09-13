import * as fs from "node:fs";
import { initializeConversationRuntime } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/cli/dist/cli.js";
import { AgentLoop } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/agent/loop.js";

const cwd = "/Users/lixiaohua/.claude/jobs/2f01f74e/tmp/ws";
const model = process.env.ANTHROPIC_MODEL || "deepseek-v4-flash";
const OUT = "/Users/lixiaohua/.claude/jobs/2f01f74e/tmp/e2e-verify.md";

if (process.cwd() !== cwd) {
  console.error(`❌ 进程 cwd (${process.cwd()}) 必须等于工作区 (${cwd})`);
  process.exit(1);
}

const RUNS = [
  {
    label: "A. 个人决策（验证补的记忆/日记 + 路径修复）",
    question: "我爸妈一直想让我回老家考公务员，但我更想留在大城市做技术。我该听他们的吗？",
  },
  {
    label: "B. 外部事实（验证联网技能自主触发）",
    question: "帮我查一下 DeepSeek V4 现在的 API 定价是多少，我最近在算成本。",
  },
];

const out = [];
const w = (s = "") => out.push(s);
const summary = [];

for (const run of RUNS) {
  const rt = await initializeConversationRuntime({
    cwd,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model,
  });

  const pending = [];
  const errors = [];
  const eventBus = {
    emit(e) {
      if (e.type === "tool-use-detected") {
        for (const tu of e.toolUses) pending.push({ name: tu.name, input: tu.input, result: null });
      } else if (e.type === "tool-execute-complete") {
        const slot = pending.find((p) => p.name === e.toolName && p.result === null);
        if (slot) slot.result = e.result;
      } else if (e.type === "agent-loop-terminated") {
        errors.push(`循环终止：${e.reason}`);
      } else if (e.type === "error") {
        errors.push(`LLM 错误：${e.error?.message ?? e.error}`);
      }
    },
  };

  const loop = new AgentLoop({ llm: rt.provider, conversation: rt.manager, tools: rt.tools, eventBus });
  let result;
  try {
    result = await loop.run(run.question);
  } catch (err) {
    errors.push(`抛出：${err.message}`);
    result = { messages: [] };
  }

  const names = pending.map((p) => p.name);
  const contentOf = (pred) => pending.filter(pred).map((p) => String(p.result?.content ?? ""));
  const joined = pending.map((p) => String(p.result?.content ?? "")).join("\n");
  const last = [...result.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");

  w(`# ${run.label}`);
  w();
  w(`问题：${run.question}`);
  w();
  if (errors.length) {
    w("**运行期错误：**");
    errors.forEach((e) => w(`- ${e}`));
    w();
  }
  w(`调用序列：\`${names.join(" → ")}\``);
  w();
  w("## 判定");
  w();

  const checks = [];
  if (run.label.startsWith("A")) {
    checks.push(["读了 decide 技能正文", contentOf((p) => p.name === "Read" && String(p.input?.file_path ?? "").includes("decide/SKILL.md")).some((c) => c.includes("帮用户做决定"))]);
    checks.push(["memory_recall 返回了真实记忆内容", contentOf((p) => p.name === "memory_recall").some((c) => !c.includes("未找到") && !c.includes("召回失败") && c.length > 40)]);
    checks.push(["journal_recall 带 query 命中条目", contentOf((p) => p.name === "journal_recall" && p.input?.query).some((c) => !c.includes("没有找到"))]);
    checks.push(["读到了人物档案内容", joined.includes("爸妈") && joined.includes("海南")]);
    checks.push(["没有瞎找路径（无 Bash 探测 people/memory 目录）", !pending.some((p) => p.name === "Bash" && /find \/|ls .*people|\$\(dirname/.test(String(p.input?.command ?? "")))]);
  } else {
    checks.push(["读了 web-search 技能正文", contentOf((p) => p.name === "Read" && String(p.input?.file_path ?? "").includes("web-search/SKILL.md")).some((c) => c.includes("联网搜索"))]);
    checks.push(["用 Bash 跑了 search.mjs", pending.some((p) => p.name === "Bash" && String(p.input?.command ?? "").includes("search.mjs"))]);
    checks.push(["搜索返回了真实结果（含 http 链接）", contentOf((p) => p.name === "Bash").some((c) => c.includes("http") && c.includes("条"))]);
  }
  checks.push(["最终回答非空", Boolean(last?.content)]);

  for (const [name, ok] of checks) {
    w(`- ${name}：${ok ? "✅" : "❌"}`);
    summary.push(`${run.label[0]} ${ok ? "✅" : "❌"} ${name}`);
  }
  w();

  w("## 工具调用明细");
  w();
  pending.forEach((p, i) => {
    w(`### ${i + 1}. \`${p.name}\``);
    w();
    w("```json");
    w(JSON.stringify(p.input, null, 2));
    w("```");
    const r = p.result;
    if (!r) w("（未捕获结果）");
    else if (r.status === "success") {
      const c = String(r.content ?? "");
      w("```");
      w(c.length > 900 ? c.slice(0, 900) + `\n…（共 ${c.length} 字符）` : c);
      w("```");
    } else w(`**错误：** ${r.error}`);
    w();
  });

  w("## 最终回答");
  w();
  w(last?.content || "(空)");
  w();
  w("---");
  w();

  await rt.extensions.shutdown();
}

fs.writeFileSync(OUT, out.join("\n"), "utf-8");
console.log(`已写入: ${OUT}\n`);
summary.forEach((s) => console.log(s));
