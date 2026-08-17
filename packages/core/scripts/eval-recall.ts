// 召回率评测脚本。用法：
//   ANTHROPIC_AUTH_TOKEN=... pnpm tsx packages/core/scripts/eval-recall.ts --mode=tool
//   （ANTHROPIC_API_KEY 亦可作为凭证回退；EVAL_MODEL 可覆盖默认模型 kimi-k3）
// 数据：seed-memories.json（写入临时 MemoryStore）、cases.json（评测用例）
// 输出：eval-recall/results-<mode>.json + 控制台汇总表
//
// baseline 模式已随旧召回机制（memory/recall.ts）一并删除；
// 基线数据存档于 eval-recall/results-baseline.json。
// tool 模式由 Task 7 实现。
const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice(7);

if (mode === "baseline") {
  console.error(
    "baseline 模式已移除：旧召回机制（MemoryRecall）已删除，基线数据见 eval-recall/results-baseline.json"
  );
  process.exit(1);
}
if (mode === "tool") {
  console.error("tool 模式由 Task 7 实现");
  process.exit(1);
}
console.error(`unknown mode: ${mode ?? "(missing)"}（仅支持 --mode=tool，由 Task 7 实现）`);
process.exit(1);
