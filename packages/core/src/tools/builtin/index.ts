import { bashTool } from "./bash.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { journalRecallTool } from "./journal-recall.js";
import { profileRecallTool } from "./profile-recall.js";
import { decideTool } from "./decide.js";
import { decideSaveTool } from "./decide-save.js";
import { decidePlanTool } from "./decide-plan.js";
import type { Tool } from "../types.js";

export const builtinTools: Tool[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  journalRecallTool,
  profileRecallTool,
  decideTool,
  decideSaveTool,
  decidePlanTool,
];

export { bashTool, readTool, writeTool, editTool, globTool, grepTool, journalRecallTool, profileRecallTool, decideTool, decideSaveTool, decidePlanTool };
