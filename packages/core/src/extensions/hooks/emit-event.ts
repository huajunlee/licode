import type { PipelineEvent } from "../../events/types.js";
import type { HookManager } from "./manager.js";

/**
 * Emit a synthetic "agent-loop-complete" event to hooks registered at the
 * "after:agentLoop" pipeline position.
 *
 * This exists because the pipeline middleware chain passes the original
 * event (e.g. "user-message") through to every middleware, but
 * after-agent-loop hooks listen for "agent-loop-complete".  Callers must
 * construct the correct event type so hook event-matching works.
 *
 * Used by the CLI's pipeline construction in place of passing the raw
 * pipeline event to {@link HookManager.onEvent}.
 */
export async function emitAfterAgentLoop(hooks: HookManager): Promise<void> {
  const event: PipelineEvent = {
    type: "agent-loop-complete",
    message: "",
    usage: { input: 0, output: 0 },
  };
  await hooks.onEvent(event, hooks.getHooksAt("after:agentLoop"));
}
