import { JournalStore } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/diary/store.js";

const store = new JournalStore("/Users/lixiaohua/.claude/jobs/2f01f74e/tmp/ws/.licode/journal");

const queries = [
  "字节跳动",              // 单词，原文里确实有
  "投递简历",              // 单词，原文里确实有
  "大厂",                  // 单词，原文里确实有
  "字节跳动 投递简历",     // 两词（模型实际写法）
  "字节跳动 投递简历 面试 大厂", // 记录第 15 条的原文 query
  "爸妈",                  // 单词
  "公务员 考公 老家 爸妈", // 记录第 3 条的原文 query
];

console.log("总条目数:", (await store.listAll()).length);
console.log("");
for (const q of queries) {
  const hits = await store.search(q);
  console.log(`${hits.length > 0 ? "✅" : "❌"} search(${JSON.stringify(q)}) -> ${hits.length} 条`);
}
