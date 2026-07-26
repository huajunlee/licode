import { describe, it, expect } from "vitest";
import { HookManager } from "./manager.js";
import { emitAfterAgentLoop } from "./emit-event.js";
import { EventPipeline } from "../../events/pipeline.js";
import type { PipelineEvent } from "../../events/types.js";

describe("emitAfterAgentLoop", () => {
  it("fires hooks registered for agent-loop-complete events", async () => {
    const manager = new HookManager();
    let hookCalled = false;

    manager.register({
      name: "memory-extract",
      events: ["agent-loop-complete"],
      fn: async () => { hookCalled = true; },
      resolvedPosition: "after:agentLoop",
    });

    await emitAfterAgentLoop(manager);

    expect(hookCalled).toBe(true);
  });

  it("does NOT fire hooks registered for other event types", async () => {
    const manager = new HookManager();
    let hookCalled = false;

    manager.register({
      name: "bash-notify",
      events: ["tool-execute-start"],
      fn: async () => { hookCalled = true; },
      resolvedPosition: "before:agentLoop",
    });

    // Hooks are at "before:agentLoop", but emitAfterAgentLoop
    // only fires hooks at "after:agentLoop"
    await emitAfterAgentLoop(manager);

    expect(hookCalled).toBe(false);
  });

  it("integrates correctly in a pipeline as hook:after:agentLoop middleware", async () => {
    const manager = new HookManager();
    const timeline: string[] = [];

    manager.register({
      name: "memory-extract",
      events: ["agent-loop-complete"],
      fn: async () => { timeline.push("hook-fired"); },
      resolvedPosition: "after:agentLoop",
    });

    const pipeline = new EventPipeline();

    // Simulate the agent loop completing
    pipeline.use("agentLoop", async (_event, next) => {
      timeline.push("agent-loop");
      await next();
    });

    // Use emitAfterAgentLoop as the hook:after:agentLoop middleware
    pipeline.use("hook:after:agentLoop", async (_event, next) => {
      await next();
      await emitAfterAgentLoop(manager);
    });

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "我叫小明" };
    }

    await pipeline.run(events());

    // Hook must fire after the agent loop
    expect(timeline).toEqual(["agent-loop", "hook-fired"]);
  });

  it("shell hooks at after:agentLoop also fire via emitAfterAgentLoop", async () => {
    const manager = new HookManager();
    const fired: string[] = [];

    manager.register({
      name: "fn-hook",
      events: ["agent-loop-complete"],
      fn: async () => { fired.push("fn"); },
      resolvedPosition: "after:agentLoop",
    });

    manager.register({
      name: "shell-hook",
      events: ["agent-loop-complete"],
      command: "echo shell",
      resolvedPosition: "after:agentLoop",
    });

    await emitAfterAgentLoop(manager);

    // Both fn and shell hooks should fire
    expect(fired).toContain("fn");
  });
});
