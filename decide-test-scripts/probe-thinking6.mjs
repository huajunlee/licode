// 直接打原始 /v1/messages，独立验证哪种形状合法（不经 provider）
const base = (process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/$/, "");
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL || "deepseek-v4-flash";

const tools = [
  {
    name: "Read",
    description: "读取文件",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
];

async function call(body) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 512, tools, ...body }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// 先拿一个真实 thinking 块（非流式）
const first = await call({ messages: [{ role: "user", content: "请读取 a.txt 文件。" }] });
if (!first.ok) {
  console.log("首轮就失败:", first.status, first.text.slice(0, 200));
  process.exit(1);
}
const parsed = JSON.parse(first.text);
const thinkBlock = (parsed.content || []).find((b) => b.type === "thinking");
const toolBlock = (parsed.content || []).find((b) => b.type === "tool_use");
console.log(`首轮 content 块: ${(parsed.content || []).map((b) => b.type).join(", ")}`);
if (!thinkBlock || !toolBlock) {
  console.log("没同时拿到 thinking 与 tool_use，无法测试");
  process.exit(0);
}
console.log(`signature: ${String(thinkBlock.signature).slice(0, 20)}…\n`);

const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: toolBlock.id, content: "内容" }] };
const base2 = [{ role: "user", content: "请读取 a.txt 文件。" }];

const cases = [
  [
    "① 拆分：assistant(text) + assistant(thinking+tool_use)   ← LICode 现状",
    [base2[0], { role: "assistant", content: "好的。" }, { role: "assistant", content: [thinkBlock, toolBlock] }, toolResult],
  ],
  [
    "② 合并：assistant(thinking+text+tool_use)",
    [base2[0], { role: "assistant", content: [thinkBlock, { type: "text", text: "好的。" }, toolBlock] }, toolResult],
  ],
  [
    "③ 合并：assistant(thinking+tool_use)，无文本",
    [base2[0], { role: "assistant", content: [thinkBlock, toolBlock] }, toolResult],
  ],
  [
    "④ 合并但 thinking 放最后",
    [base2[0], { role: "assistant", content: [{ type: "text", text: "好的。" }, toolBlock, thinkBlock] }, toolResult],
  ],
];

for (const [name, messages] of cases) {
  const r = await call({ messages });
  if (r.ok) console.log(`✅ ${name}`);
  else {
    let msg = r.text;
    try {
      msg = JSON.parse(r.text).error?.message ?? r.text;
    } catch {}
    console.log(`❌ ${name}\n     ${String(msg).slice(0, 160)}`);
  }
}
