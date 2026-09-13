/**
 * 消融实验：decide 技能到底有没有用？
 *
 * 两个臂，同一个问题、同一个 fixture、同一套工具与提示层，唯一差别是
 * **内置技能目录里有没有 decide**：
 *   with-skill  decide 技能在
 *   no-skill    把 decide 目录临时移开（try/finally 保证还原）
 *
 * 注意 no-skill 臂仍然保留：memory_recall 工具、memory-guide/memory-presence 层、
 * people-presence 层、journal_recall 工具。也就是说基线并不弱——它拿得到所有数据，
 * 只是没有 decide 那份「先取证再判断」的流程指令。这正是要测的东西。
 *
 * 关键判据：**答案有没有引用用户真实记录过的历史**（具体日期、事件、情绪强度）。
 * 这些只有真去读日记/记忆/档案才可能知道。基线若自发去读了，技能价值就有限。
 *
 * 用法：必须让进程 cwd == 工作区
 *   cd decide-test-workspace && node ../decide-test-scripts/ablation.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initializeConversationRuntime } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/cli/dist/cli.js";
import { AgentLoop } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/agent/loop.js";

const ROOT = "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure";
const cwd = `${ROOT}/decide-test-workspace`;
const SKILL_DIR = `${ROOT}/packages/core/dist/extensions/skills/builtin/decide`;
// 必须挪到 builtin 目录**之外**！loader 会遍历 builtin 的每个子目录、
// 按 SKILL.md 里的 frontmatter name 注册技能——改名成 decide.stash 放在原地
// 等于没动，两臂都会带上 decide，实验变成 decide-vs-decide（踩过这个坑）。
const STASH = `${ROOT}/.ablation-stash/decide`;
const OUT = `${ROOT}/ablation-result.md`;

const model = process.env.ANTHROPIC_MODEL || "deepseek-v4-flash";
const TRIALS = Number(process.env.ABLATION_TRIALS || 3);

const QUESTION = "我爸妈一直想让我回老家考公务员，但我更想留在大城市做技术。我该听他们的吗？";

if (process.cwd() !== cwd) {
  console.error(`❌ 进程 cwd (${process.cwd()}) 必须等于工作区 (${cwd})`);
  process.exit(1);
}

// ---------- 判据 ----------

/** 答案里出现的、用户真实记录过的具体日期（fixture 日记里的日期） */
const KNOWN_DATES = [
  "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-05",
  "2026-08-21", "2026-08-28", "2026-09-05", "2026-09-10",
];
/** fixture 里独有的具体事实——没读过数据不可能知道 */
const KNOWN_FACTS = [
  { key: "中海油", desc: "父母要求投递中海油海南分公司" },
  { key: "豪悦客", desc: "带父母吃牛排的具体店名" },
  { key: "字节跳动", desc: "投递字节跳动" },
  { key: "师兄", desc: "09-10 与师兄交流" },
  { key: "堵闷", desc: "08-28 挂电话后的情绪（强度4）" },
  { key: "两难", desc: "09-05 的情绪（强度4）" },
  { key: "6000", desc: "大城市月支出至少六千" },
  { key: "3000", desc: "实习工资三千出头" },
  { key: "网站编辑", desc: "实习岗位性质" },
];

/** 模型有没有 Read 过某个路径（看 tool_use 的入参，不看结果文本） */
function readsPath(messages, frag) {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((b) => JSON.stringify(b.input ?? {}).includes(frag))
  );
}

function scoreAnswer(text) {
  const t = text || "";
  const dates = KNOWN_DATES.filter((d) => t.includes(d));
  const facts = KNOWN_FACTS.filter((f) => t.includes(f.key));
  return {
    charCount: t.length,
    dates,
    facts: facts.map((f) => f.key),
    // 有明确倾向（决定式表述），不是两头都说好话
    hasStance: /我的倾向|我倾向|我更建议|我的建议|如果非要|倾向性建议/.test(t),
    // 列了不确定性
    hasUncertainty: /不确定|无法确认|我不知道|待确认|需要你补|你才能补/.test(t),
    // 给了可执行动作
    hasAction: /具体动作|下一步|建议你|你可以先|止损/.test(t),
  };
}

// ---------- 运行 ----------

const results = [];
const transcripts = [];

/**
 * 断言消融操作真的生效：开一个 runtime，看书目层里还有没有 decide。
 * 这是必须的——第一次跑时把 decide 改名留在 builtin 里，loader 照样加载，
 * 结果两臂完全一样，白跑 6 次 API 还差点得出"技能无效"的错误结论。
 */
async function skillsCatalogHas(tag, needle) {
  const rt = await initializeConversationRuntime({
    cwd,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model,
  });
  const layer = rt.manager.systemPrompt.getLayers().find((l) => l.name === "skills");
  const has = new RegExp(`^- ${needle}：`, "m").test(layer?.content ?? "");
  await rt.extensions.shutdown();
  console.log(`   [自检] ${tag}：书目层${has ? "含" : "不含"} ${needle}`);
  return has;
}

async function runOne(arm, trial) {
  const rt = await initializeConversationRuntime({
    cwd,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model,
  });

  const errors = [];
  const eventBus = {
    emit(e) {
      if (e.type === "error") errors.push(`${e.error?.message ?? e.error}`);
      if (e.type === "agent-loop-terminated") errors.push(`终止: ${e.reason}`);
    },
  };
  const loop = new AgentLoop({ llm: rt.provider, conversation: rt.manager, tools: rt.tools, eventBus });

  const t0 = Date.now();
  let res;
  try {
    res = await loop.run(QUESTION);
  } catch (err) {
    errors.push(`抛出: ${err.message}`);
    res = { messages: rt.manager.getMessages() };
  }
  const seconds = (Date.now() - t0) / 1000;

  const messages = [...res.messages];
  const toolCalls = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) toolCalls.push(b.name);
    }
  }
  const last = [...messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string");
  const answer = last?.content ?? "";

  // 模型有没有真去读用户数据（看工具结果里有没有 fixture 独有内容）
  const allResults = messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => m.content.map((r) => String(r.content ?? "")))
    .join("\n");
  const readData = KNOWN_FACTS.filter((f) => allResults.includes(f.key)).map((f) => f.key);
  const readDates = KNOWN_DATES.filter((d) => allResults.includes(d));

  const rec = {
    arm,
    trial,
    seconds: Number(seconds.toFixed(1)),
    toolCalls,
    toolCount: toolCalls.length,
    // 看工具**入参**里有没有 Read 决定技能的 SKILL.md——比在结果里找文本可靠
    readDecideSkill: readsPath(messages, "decide/SKILL.md"),
    readWebSearchSkill: readsPath(messages, "web-search/SKILL.md"),
    evidence: { facts: readData, dates: readDates },
    score: scoreAnswer(answer),
    errors,
    answer,
  };
  results.push(rec);

  // 完整转录（供人工判读）
  const tr = [`## ${arm} · 第 ${trial} 次`, "", `耗时 ${rec.seconds}s | 工具调用 ${rec.toolCount} 次`, ""];
  tr.push(`调用序列：\`${toolCalls.join(" → ") || "(无)"}\``, "");
  if (errors.length) tr.push(`错误：${errors.join(" | ")}`, "");
  tr.push("### 最终回答", "", answer || "**(空)**", "", "---", "");
  transcripts.push(tr.join("\n"));

  await rt.extensions.shutdown();
  return rec;
}

// ---------- 主流程 ----------

const hasSkill = fs.existsSync(SKILL_DIR);
if (!hasSkill) {
  console.error(`❌ 没找到 decide 技能目录：${SKILL_DIR}`);
  process.exit(1);
}

try {
  // ---- 臂 1：带技能 ----
  if (!(await skillsCatalogHas("with-skill 前置", "decide"))) {
    throw new Error("with-skill 臂的书目层里没有 decide，实验前提不成立");
  }
  console.log(`\n=== with-skill 臂（${TRIALS} 次）===`);
  for (let i = 1; i <= TRIALS; i++) {
    const r = await runOne("with-skill", i);
    console.log(`  #${i}: ${r.toolCount} 次调用, 引用事实 ${r.score.facts.length} 条, 日期 ${r.score.dates.length} 个`);
  }

  // ---- 臂 2：不带技能 ----
  fs.mkdirSync(path.dirname(STASH), { recursive: true });
  fs.renameSync(SKILL_DIR, STASH);
  if (await skillsCatalogHas("no-skill 前置", "decide")) {
    throw new Error("decide 已移开但书目层仍在列它——消融没生效，结果无意义");
  }
  console.log(`\n=== no-skill 臂（decide 已移开，${TRIALS} 次）===`);
  for (let i = 1; i <= TRIALS; i++) {
    const r = await runOne("no-skill", i);
    console.log(`  #${i}: ${r.toolCount} 次调用, 引用事实 ${r.score.facts.length} 条, 日期 ${r.score.dates.length} 个`);
  }
} finally {
  // 无论成功失败都要还原，否则 dist 里的 decide 就没了
  if (fs.existsSync(STASH)) {
    fs.mkdirSync(path.dirname(SKILL_DIR), { recursive: true });
    fs.renameSync(STASH, SKILL_DIR);
    console.log("\n✅ 已还原 decide 技能目录");
  }
}

// ---------- 出报告 ----------

const md = [];
const w = (s = "") => md.push(s);
w("# decide 技能消融实验");
w();
w(`- 日期：2026-09-14`);
w(`- 模型：\`${model}\``);
w(`- 每臂次数：${TRIALS}`);
w(`- 问题：${QUESTION}`);
w();
w("## 实验设计");
w();
w("两个臂唯一差别是**内置技能目录里有没有 decide**。基线臂仍保留 memory_recall、");
w("journal_recall、memory-guide / people-presence 提示层——数据它都拿得到，");
w("只是没有 decide 那份「先取证再判断」的流程指令。");
w();

const arms = ["with-skill", "no-skill"];
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

w("## 汇总");
w();
w("| 指标 | with-skill | no-skill |");
w("|---|---|---|");
for (const [label, fn] of [
  ["工具调用次数（均值）", (rs) => avg(rs.map((r) => r.toolCount)).toFixed(1)],
  ["耗时秒（均值）", (rs) => avg(rs.map((r) => r.seconds)).toFixed(1)],
  ["答案字数（均值）", (rs) => avg(rs.map((r) => r.score.charCount)).toFixed(0)],
  ["**引用真实事实条数（均值/9）**", (rs) => avg(rs.map((r) => r.score.facts.length)).toFixed(1)],
  ["**引用真实日期个数（均值/8）**", (rs) => avg(rs.map((r) => r.score.dates.length)).toFixed(1)],
  ["有明确倾向的比例", (rs) => `${rs.filter((r) => r.score.hasStance).length}/${rs.length}`],
  ["列了不确定性的比例", (rs) => `${rs.filter((r) => r.score.hasUncertainty).length}/${rs.length}`],
  ["给了可执行动作的比例", (rs) => `${rs.filter((r) => r.score.hasAction).length}/${rs.length}`],
  ["**读了 decide 技能的比例**", (rs) => `${rs.filter((r) => r.readDecideSkill).length}/${rs.length}`],
  ["读了 web-search 技能的比例", (rs) => `${rs.filter((r) => r.readWebSearchSkill).length}/${rs.length}`],
  ["自发读人物档案的比例", (rs) => `${rs.filter((r) => r.evidence.facts.length > 0).length}/${rs.length}`],
  ["用了 journal_recall 的比例", (rs) => `${rs.filter((r) => r.toolCalls.includes("journal_recall")).length}/${rs.length}`],
  ["用了 memory_recall 的比例", (rs) => `${rs.filter((r) => r.toolCalls.includes("memory_recall")).length}/${rs.length}`],
]) {
  const a = arms.map((arm) => fn(results.filter((r) => r.arm === arm)));
  w(`| ${label} | ${a[0]} | ${a[1]} |`);
}
w();

w("## 逐次明细");
w();
for (const arm of arms) {
  w(`### ${arm}`);
  w();
  w("| 次 | 工具调用 | 引用事实 | 引用日期 | 字数 | 倾向 |");
  w("|---|---|---|---|---|---|");
  for (const r of results.filter((x) => x.arm === arm)) {
    w(`| ${r.trial} | ${r.toolCount} | ${r.score.facts.join(", ") || "—"} | ${r.score.dates.length} | ${r.score.charCount} | ${r.score.hasStance ? "有" : "无"} |`);
  }
  w();
}

w("---");
w();
w("## 完整回答");
w();
w(transcripts.join("\n"));

fs.writeFileSync(OUT, md.join("\n"), "utf-8");
console.log(`\n已写入: ${OUT}`);
