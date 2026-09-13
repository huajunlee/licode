// 用 parse/serialize 往返更新人物档案，避免手写格式漂移
import * as fs from "node:fs";
import { parseProfile, serializeProfile } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/people/serialize.js";

const file = "/Users/lixiaohua/.claude/jobs/2f01f74e/tmp/ws/.licode/people/爸妈.md";
const p = parseProfile(fs.readFileSync(file, "utf-8"));
if (!p) throw new Error("解析失败");

p.meta.lastSeen = "2026-08-28";
p.meta.mentionCount = 3;

// 前 100 字会进 frontmatter，绝不能含换行，否则 frontmatter 解析崩掉
p.summary =
  "用户父母，家在海南。主张稳定优先，希望儿子回老家、进国央企或考公务员；" +
  "用户想留大城市做技术，双方在就业观上持续分歧。\n\n" +
  "2026-08-01 通话时明确要求投递中海油海南分公司。2026-08-02 用户带他们去吃牛排，" +
  "说明关系本身不差，也会主动汇报近况——分歧集中在就业观，不是感情问题，" +
  "不要按「原生家庭冲突」处理。\n\n" +
  "施压方式偏直接：2026-08-28 母亲提「岗位今年放出来不少，错过等明年」，" +
  "父亲说「你在外面漂着有什么意思」。用户目前的应对是回避——既不答应也不拒绝。";

p.interactions.push(
  { date: "2026-08-02", entryId: "msalh8jz", event: "用户带父母去豪悦客吃牛排，他们对这顿饭很满意" },
  { date: "2026-08-28", entryId: "mt9k2vqa", event: "电话催促公务员报名；父亲质疑在外漂泊的意义；用户敷衍未表态" }
);
p.relationshipState.push({ date: "2026-08-28", state: "因就业去向产生张力，用户回避表态" });

fs.writeFileSync(file, serializeProfile(p), "utf-8");
console.log(fs.readFileSync(file, "utf-8"));

// 回读校验
const again = parseProfile(fs.readFileSync(file, "utf-8"));
console.log("回读校验:", again ? `OK, ${again.interactions.length} 条互动, 概述 ${again.summary.length} 字` : "失败");
