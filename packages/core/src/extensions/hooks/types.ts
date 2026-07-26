import type { PipelineEvent } from "../../events/types.js";

export type HookPosition = `before:${string}` | `after:${string}`;

/** In-process hook function (Step 2). Receives the pipeline event. */
export type HookFunction = (event: PipelineEvent) => Promise<void>;

export interface HookConfig {
  events: string[];
  /** Shell command to execute (mutually exclusive with `fn`) */
  command?: string;
  /** In-process function to call (mutually exclusive with `command`) */
  fn?: HookFunction;
  position?: string;
  timeout?: number;
  blocking?: boolean;
}

export interface RegisteredHook extends HookConfig {
  name: string;
  resolvedPosition: HookPosition;
}
