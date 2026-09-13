const B = "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure";
const ws = `${B}/decide-test-workspace`;
const { JournalStore } = await import(`${B}/packages/core/dist/diary/store.js`);
const { MemoryStore } = await import(`${B}/packages/core/dist/memory/store.js`);
const { PersonProfileStore } = await import(`${B}/packages/core/dist/people/store.js`);

const j = new JournalStore(`${ws}/.licode/journal`);
const all = await j.listAll();
console.log(`日记 ${all.length} 天`);

// 这条正是修复前返回 0 条的那个多词查询
const hits = await j.search("公务员 考公 老家 爸妈");
console.log(`多词查询「公务员 考公 老家 爸妈」命中 ${hits.length} 条: ${hits.map((e) => e.meta.date).join(", ")}`);

const m = new MemoryStore(`${ws}/.licode/memory`);
const mems = await m.listAll();
console.log(`记忆 ${mems.length} 条: ${mems.map((x) => x.slug).join(", ")}`);

const p = new PersonProfileStore(`${ws}/.licode/people`);
const people = await p.listAll();
console.log(`人物档案 ${people.length} 份: ${people.map((x) => x.meta.canonicalName).join(", ")}`);
