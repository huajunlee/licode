import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { SubAgentManager } from "./subagent.js";

export function createAgentTool(manager: SubAgentManager): Tool {
  return {
    name: "Agent",
    description: "Delegate a focused task to a subagent.",
    parameters: z.object({
      agent: z.string().optional(),
      task: z.string().min(1),
      isolation: z.enum(["none", "worktree"]).optional(),
      tools: z.array(z.string()).optional(),
      maxSteps: z.number().int().positive().optional(),
    }),
    execute(input, context) {
      return manager.execute(input, context);
    },
  };
}
