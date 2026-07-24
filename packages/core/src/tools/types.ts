import { z, ZodTypeAny } from "zod";
import type { Sandbox } from "../safety/sandbox.js";

export interface Tool<TParams extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  parameters: TParams;
  execute(
    input: z.infer<TParams>,
    context: ToolContext
  ): Promise<ToolResult>;
  requiresApproval?: boolean;
}

export interface ToolContext {
  workingDirectory: string;
  sessionId: string;
  signal?: AbortSignal;
  sandbox?: Sandbox;
}

export type ToolResult =
  | { status: "success"; content: string; metadata?: Record<string, unknown> }
  | { status: "error"; error: string; errorType: "validation" | "execution" | "timeout" };
