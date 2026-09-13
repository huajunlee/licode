// 用真实 JournalStore 写入补充日记，保证格式与生产一致
import { JournalStore } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/diary/store.js";
import { emptyEntry } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/diary/types.js";

const store = new JournalStore("/Users/lixiaohua/.claude/jobs/2f01f74e/tmp/ws/.licode/journal");

const drafts = [
  {
    id: "mt9k2vqa",
    title: "父母再提考公",
    date: "2026-08-28",
    at: "2026-08-28T14:05:00.000Z",
    text:
      "晚上爸妈又打电话过来，问我公务员报名的事准备了没有。我说还在看，其实我根本没看。我妈说老家这边岗位今年放出来不少，错过就要等明年。我爸在旁边说了一句「你在外面漂着有什么意思」。我没接话，聊了几句就挂了。挂了以后心里挺堵的，不是气他们，是气我自己连句实话都说不出来。",
    summary:
      "父母再次催促公务员报名，用户以「还在看」敷衍，实际未准备。父亲说「你在外面漂着有什么意思」，用户未回应，挂断后感到堵闷。",
    people: [
      { name: "爸妈", relation: "父母", interaction: "电话催促公务员报名，父亲质疑在外漂泊的意义", specific: true },
    ],
    emotions: [{ state: "堵闷", intensity: 4, trigger: "无法对父母说出真实想法" }],
    facts: [
      { what: "父母电话催促公务员报名", when: "2026-08-28晚上" },
      { what: "老家岗位今年放出较多，错过要等明年", when: "2026-08-28" },
      { what: "用户以「还在看」敷衍，实际未准备", when: "2026-08-28" },
    ],
    decisions: [
      { decision: "继续回避向父母表态", reasoning: "还没想好怎么说，也怕争吵", context: "通话时选择敷衍" },
    ],
  },
  {
    id: "mub7xp3d",
    title: "实习两周的怀疑",
    date: "2026-09-05",
    at: "2026-09-05T12:40:00.000Z",
    text:
      "实习满两周了。说实话做的事情跟技术没什么关系，就是更新网站、做推广图。今天经理让我把上周的推广数据整理成表格，我做了一下午。字节那边投了快一个月，一点回音都没有。晚上有点怀疑自己，是不是我这条路本来就难走，爸妈说的也不是没道理。但又想到真回老家进国央企，每天干的可能就是今天这种活，还一眼看到头。两种都不想要，不知道怎么办。",
    summary:
      "实习两周，工作内容偏运营推广，与技术方向不符。字节跳动投递近一个月无回音，用户开始怀疑自己的选择，同时对回老家进国央企也排斥，陷入两难。",
    people: [
      { name: "经理", relation: "上级", interaction: "安排整理推广数据", specific: true },
    ],
    emotions: [
      { state: "怀疑", intensity: 4, trigger: "投递无回音 + 实习不对口" },
      { state: "两难", intensity: 4, trigger: "两条路都不想要" },
    ],
    facts: [
      { what: "实习满两周，工作内容为网站更新与推广图", when: "2026-09-05" },
      { what: "投递字节跳动近一个月无回音", when: "2026-09-05" },
      { what: "经理安排整理上周推广数据", when: "2026-09-05" },
    ],
    decisions: [
      { decision: "尚未决定是否改变方向", reasoning: "两条路都有明确的排斥点", context: "实习两周后的自我怀疑" },
    ],
  },
  {
    id: "mvq4n8we",
    title: "算了一笔账",
    date: "2026-09-10",
    at: "2026-09-10T15:20:00.000Z",
    text:
      "今天闲着算了一笔账。大城市这边房租加吃饭一个月至少要六千，实习工资三千出头，等于每个月都在倒贴。老家的话住家里，国央企到手虽然不多但花不掉，攒得下来。算完心里咯噔一下。但转念又想，我要是这么算，那这辈子就这么算了。跟师兄聊了两句，他说他当年也纠结过，后来还是留下来了，现在也不算差。",
    summary:
      "用户计算大城市与老家的收支：大城市月支出至少六千、实习工资仅三千出头；老家住家里可攒钱。算完后动摇，但与师兄交流后倾向仍留大城市。",
    people: [
      { name: "师兄", relation: "研究生项目同门", interaction: "交流当年留在大城市的经历", specific: true },
    ],
    emotions: [
      { state: "动摇", intensity: 3, trigger: "收支账算下来是倒贴" },
    ],
    facts: [
      { what: "大城市月支出至少六千元", when: "2026-09-10" },
      { what: "实习工资三千出头", when: "2026-09-10" },
      { what: "师兄当年也纠结过，最终留在大城市", when: "2026-09-10" },
    ],
    decisions: [
      { decision: "倾向仍留在大城市", reasoning: "不想因为算账就放弃技术方向", context: "与师兄交流后" },
    ],
  },
];

for (const d of drafts) {
  const e = emptyEntry(d.id, d.date, d.at);
  e.title = d.title;
  e.summary = d.summary;
  e.raw = { content: d.text, segments: [{ timestamp: d.at, speaker: "user", content: d.text }] };
  e.people = d.people.map((p) => ({
    name: p.name,
    relation: p.relation,
    relationInferred: false,
    interaction: p.interaction,
    note: null,
    specific: p.specific,
  }));
  e.emotions = d.emotions.map((x) => ({ ...x, inferred: false }));
  e.facts = d.facts.map((f) => ({ ...f, tags: [] }));
  e.decisions = d.decisions.map((x) => ({ ...x }));
  await store.save(e);
  console.log(`已写入 ${d.date} ${d.title}`);
}

console.log(`\n总条目数: ${(await store.listAll()).length}`);
