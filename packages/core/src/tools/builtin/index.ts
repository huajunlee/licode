import { bashTool } from "./bash.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { journalRecallTool } from "./journal-recall.js";
import { decideSaveTool } from "./decide-save.js";
import { decideReflectTool } from "./decide-reflect.js";
import type { Tool } from "../types.js";

// 决策（decide / decide_plan / profile_recall）已迁为 skill：
// 见 packages/core/src/extensions/skills/builtin/decide/SKILL.md。
// 这里保留的是 skill 无法替代的两件确定性工作：
// decide_save 按固定结构写日记，decide_reflect 起独立模型做隔离评审。
export const builtinTools: Tool[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  journalRecallTool,
  decideSaveTool,
  decideReflectTool,
];

export { bashTool, readTool, writeTool, editTool, globTool, grepTool, journalRecallTool, decideSaveTool, decideReflectTool };
