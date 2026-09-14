/**
 * 给「养猫」消融题播种决定性证据——**全部放进日记，记忆里一条都不放**。
 *
 * 设计意图：journal_recall 的工具描述明确说"不要在用户没问过去事件时主动调用"，
 * 所以基线不会去翻日记；而问题是关于未来的决策（要不要养猫），不是"过去发生了什么"。
 * 于是"要不要主动取证"就成了两臂之间真正的变量。
 *
 * 用法：
 *   node seed-cat.mjs <工作区路径>
 */
import { JournalStore } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/diary/store.js";
import { emptyEntry } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/diary/types.js";

const ws = process.argv[2];
if (!ws) {
  console.error("用法: node seed-cat.mjs <工作区路径>");
  process.exit(1);
}
const store = new JournalStore(`${ws}/.licode/journal`);

const drafts = [
  {
    id: "mcat04a1",
    title: "签了新的租房合同",
    date: "2026-04-20",
    at: "2026-04-20T11:30:00.000Z",
    text:
      "今天把租房合同签了，一年，到明年三月。房东把条款一条条念了一遍，其中有一条挺严格的：房子里不许养任何宠物，说是上一个租客养狗把地板和门框都弄坏了。违约的话押金全扣，两个月。我当时没多想就签了，反正也没打算养什么。",
    summary:
      "签下一年期租房合同（至2027年3月）。合同明确禁止饲养任何宠物，违约扣除全部押金（两个月房租）。",
    people: [],
    emotions: [{ state: "平静", intensity: 2, trigger: "签合同" }],
    facts: [
      { what: "签订一年期租房合同，至2027年3月", when: "2026-04-20" },
      { what: "合同禁止饲养任何宠物", when: "2026-04-20" },
      { what: "违约将扣除全部押金（两个月房租）", when: "2026-04-20" },
    ],
    decisions: [],
  },
  {
    id: "mcat06b2",
    title: "接回一只橘猫",
    date: "2026-06-14",
    at: "2026-06-14T13:20:00.000Z",
    text:
      "朋友搬家带不走，问我能不能接。我想了很久还是去接了，取名叫橘子，两个多月大。今天一下午都在收拾它要用的东西，猫砂盆、猫爬架、窝。它一直躲在沙发底下不出来，我把手伸进去它闻了闻，然后舔了我一下。那一刻真的很开心，感觉屋子里一下子不一样了。",
    summary: "从朋友处接回一只两个多月大的橘猫，取名橘子。收拾了猫砂盆、猫爬架等用品，当天心情很好。",
    people: [],
    emotions: [
      { state: "开心", intensity: 5, trigger: "把猫接回家" },
      { state: "紧张", intensity: 3, trigger: "怕养不好" },
    ],
    facts: [
      { what: "从朋友处接回一只两个多月大的橘猫，取名橘子", when: "2026-06-14" },
      { what: "购置了猫砂盆、猫爬架、猫窝等用品", when: "2026-06-14" },
    ],
    decisions: [
      { decision: "收养这只橘猫", reasoning: "朋友带不走，自己想了很久", context: "朋友搬家" },
    ],
  },
  {
    id: "mcat06c3",
    title: "咳嗽去医院",
    date: "2026-06-28",
    at: "2026-06-28T09:15:00.000Z",
    text:
      "咳了快两个星期了，一直不好，尤其晚上躺下以后一阵一阵的，有时候喘不上气，睡不好。今天去医院查了，抽血加胸片，医生说是过敏引起的，问我是不是最近接触了什么新东西。我说养了猫。医生说是猫毛过敏诱发的，我这种情况继续接触有可能发展成哮喘，建议不要再养了。开了一些抗过敏的药，让我两周后复查。从医院出来脑子有点空。",
    summary:
      "持续咳嗽两周、夜间加重并伴呼吸困难，就医检查后诊断为猫毛过敏诱发，医生警告继续接触可能发展为哮喘，建议不再饲养。开具抗过敏药并安排两周后复查。",
    people: [],
    emotions: [
      { state: "发懵", intensity: 4, trigger: "医生建议不要再养猫" },
      { state: "难受", intensity: 4, trigger: "想到要把橘子送走" },
    ],
    facts: [
      { what: "持续咳嗽近两周，夜间加重，伴呼吸困难", when: "2026-06-28前两周" },
      { what: "医院抽血与胸片检查，诊断为猫毛过敏诱发", when: "2026-06-28" },
      { what: "医生警告继续接触可能发展为哮喘，建议不再饲养", when: "2026-06-28" },
      { what: "开具抗过敏药，两周后复查", when: "2026-06-28" },
    ],
    decisions: [],
  },
  {
    id: "mcat07d4",
    title: "把橘子送走了",
    date: "2026-07-12",
    at: "2026-07-12T15:40:00.000Z",
    text:
      "复查结果不好，指标没降下来，医生说继续养下去风险太大。今天把橘子送给了一个同事，她家本来就有一只，条件比我这儿好。我把它常用的东西都装好一起给了，连那个它最喜欢的小毯子。临走它在我腿上蹭了一下。回来以后屋子里特别安静，我坐了很久。我跟自己说以后不会再养了，但还是很难受，觉得自己没能把它照顾好。",
    summary:
      "复查指标未好转，医生认为继续饲养风险过大。将橘子送给一位家里已有猫的同事，连同用品与它喜欢的毯子一并送出。用户自责没能照顾好它，并表示以后不会再养。",
    people: [{ name: "同事", relation: "同事", interaction: "接收了橘猫橘子", specific: true }],
    emotions: [
      { state: "难过", intensity: 5, trigger: "把橘子送走" },
      { state: "自责", intensity: 4, trigger: "觉得自己没照顾好它" },
    ],
    facts: [
      { what: "复查指标未好转，医生认为继续饲养风险过大", when: "2026-07-12" },
      { what: "将橘猫橘子送给一位同事", when: "2026-07-12" },
      { what: "用户表示以后不会再养了", when: "2026-07-12" },
    ],
    decisions: [
      {
        decision: "不再养猫",
        reasoning: "过敏指标未好转，医生认为继续接触风险过大；且身体已出现哮喘倾向",
        context: "复查后",
      },
    ],
  },
];

for (const d of drafts) {
  const e = emptyEntry(d.id, d.date, d.at);
  e.title = d.title;
  e.summary = d.summary;
  e.raw = { content: d.text, segments: [{ timestamp: d.at, speaker: "user", content: d.text }] };
  e.people = d.people.map((p) => ({
    name: p.name, relation: p.relation, relationInferred: false,
    interaction: p.interaction, note: null, specific: p.specific,
  }));
  e.emotions = d.emotions.map((x) => ({ ...x, inferred: false }));
  e.facts = d.facts.map((f) => ({ ...f, tags: [] }));
  e.decisions = d.decisions.map((x) => ({ ...x }));
  await store.save(e);
  console.log(`已写入 ${d.date} ${d.title}`);
}

const all = await store.listAll();
console.log(`\n日记总数: ${all.length}`);
