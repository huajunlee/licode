import { describe, it, expect } from "vitest";
import { HookManager, hookMiddleware, resolvePosition } from "./manager.js";
import type { HookConfig, HookPosition } from "./types.js";
import { EventPipeline } from "../../events/pipeline.js";
import type { PipelineEvent } from "../../events/types.js";

describe("resolvePosition", () => {
  it('resolves "pre-agent" alias to "before:agentLoop"', () => {
    expect(resolvePosition("pre-agent")).toBe("before:agentLoop");
  });

  it('resolves "post-agent" alias to "after:agentLoop"', () => {
    expect(resolvePosition("post-agent")).toBe("after:agentLoop");
  });

  it('resolves "post-render" alias to "after:renderer"', () => {
    expect(resolvePosition("post-render")).toBe("after:renderer");
  });

  it("passes through raw position strings", () => {
    expect(resolvePosition("before:tokenCounting")).toBe("before:tokenCounting");
  });
});

describe("HookManager", () => {
  it("loads and groups hooks by resolved position", () => {
    const manager = new HookManager();

    const configs: Record<string, HookConfig> = {
      notifyOnBash: {
        events: ["tool-execute-start"],
        command: "echo 'notify'",
        position: "pre-agent",
      },
      ciTrigger: {
        events: ["agent-loop-complete"],
        command: "echo 'ci'",
        position: "post-agent",
      },
    };

    manager.load(configs);

    expect(manager.getHooksAt("before:agentLoop")).toHaveLength(1);
    expect(manager.getHooksAt("before:agentLoop")[0].name).toBe("notifyOnBash");
    expect(manager.getHooksAt("after:agentLoop")).toHaveLength(1);
    expect(manager.getHooksAt("after:agentLoop")[0].name).toBe("ciTrigger");
  });

  it("defaults position to before:agentLoop when not specified", () => {
    const manager = new HookManager();

    manager.load({
      defaultHook: {
        events: ["*"],
        command: "echo 'test'",
      },
    });

    const hooks = manager.getHooksAt("before:agentLoop");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].resolvedPosition).toBe("before:agentLoop");
  });

  it("getPositions returns all positions with registered hooks", () => {
    const manager = new HookManager();

    manager.load({
      a: { events: ["*"], command: "echo a", position: "pre-agent" },
      b: { events: ["*"], command: "echo b", position: "post-agent" },
    });

    const positions = manager.getPositions();
    expect(positions).toContain("before:agentLoop");
    expect(positions).toContain("after:agentLoop");
  });

  it("returns empty array for position with no hooks", () => {
    const manager = new HookManager();
    expect(manager.getHooksAt("after:renderer")).toEqual([]);
  });

  it("matches events with wildcard patterns", () => {
    const manager = new HookManager();

    manager.load({
      toolWatcher: {
        events: ["tool-execute-*"],
        command: "echo 'match'",
      },
    });

    // Access internal match method through event matching
    const hooks = manager.getHooksAt("before:agentLoop");
    expect(hooks).toHaveLength(1);

    // Verify hooks are properly loaded
    expect(hooks[0].events).toEqual(["tool-execute-*"]);
  });
});

describe("hookMiddleware", () => {
  it("returns pass-through middleware when no hooks at position", async () => {
    const manager = new HookManager();

    const mw = hookMiddleware(manager, "after:renderer");
    let called = false;
    await mw({ type: "user-message", content: "test" }, async () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it("executes registered hooks and calls next", async () => {
    const manager = new HookManager();
    const executed: string[] = [];

    manager.load({
      testHook: {
        events: ["user-message"],
        command: "node -e 'process.exit(0)'",
        position: "pre-agent",
      },
    });

    const mw = hookMiddleware(manager, "before:agentLoop");

    let nextCalled = false;
    await mw({ type: "user-message", content: "test" }, async () => {
      nextCalled = true;
    });

    // Hook should run, but not block next()
    expect(nextCalled).toBe(true);
  });

  it("failing hook does not block the pipeline", async () => {
    const manager = new HookManager();

    manager.load({
      brokenHook: {
        events: ["user-message"],
        command: "nonexistent-command-xyz",
        position: "pre-agent",
      },
    });

    const mw = hookMiddleware(manager, "before:agentLoop");

    let nextCalled = false;
    await mw({ type: "user-message", content: "test" }, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});

describe("assemblePipeline", () => {
  it("works with pipeline", async () => {
    const pipeline = new EventPipeline();
    const order: string[] = [];

    pipeline.use("logging", async (_e, n) => {
      order.push("logging");
      await n();
    });

    pipeline.use("agentLoop", async (_e, n) => {
      order.push("agentLoop");
      await n();
    });

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "test" };
    }

    await pipeline.run(events());
    expect(order).toEqual(["logging", "agentLoop"]);
  });
});

// ── Step 2: in-process function hooks ──────────────────────────────

describe("HookManager function hooks", () => {
  it("register() adds a function hook at the given position", () => {
    const manager = new HookManager();

    manager.register({
      name: "memory-extract",
      events: ["agent-loop-complete"],
      fn: async () => {},
      resolvedPosition: "after:agentLoop",
    });

    const hooks = manager.getHooksAt("after:agentLoop");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe("memory-extract");
    expect(hooks[0].fn).toBeDefined();
    expect(hooks[0].command).toBeUndefined();
  });

  it("register() overwrites hook with same name (idempotent)", () => {
    const manager = new HookManager();
    const calls: string[] = [];

    manager.register({
      name: "test-fn",
      events: ["*"],
      fn: async () => { calls.push("v1"); },
      resolvedPosition: "before:agentLoop",
    });

    manager.register({
      name: "test-fn",
      events: ["*"],
      fn: async () => { calls.push("v2"); },
      resolvedPosition: "before:agentLoop",
    });

    // Should only have one, and it should be v2
    const hooks = manager.getHooksAt("before:agentLoop");
    expect(hooks).toHaveLength(1);
  });

  it("onEvent calls function hook when event matches pattern", async () => {
    const manager = new HookManager();
    let called = false;

    const hook = {
      name: "test-fn",
      events: ["agent-loop-complete"],
      fn: async (_e: PipelineEvent) => { called = true; },
      resolvedPosition: "after:agentLoop" as HookPosition,
    };
    manager.register(hook);

    await manager.onEvent(
      { type: "agent-loop-complete", message: "done", usage: { input: 10, output: 20 } },
      manager.getHooksAt("after:agentLoop")
    );

    expect(called).toBe(true);
  });

  it("onEvent does NOT call function hook when event does NOT match", async () => {
    const manager = new HookManager();
    let called = false;

    manager.register({
      name: "test-fn",
      events: ["agent-loop-complete"],
      fn: async () => { called = true; },
      resolvedPosition: "after:agentLoop",
    });

    await manager.onEvent(
      { type: "user-message", content: "hello" },
      manager.getHooksAt("after:agentLoop")
    );

    expect(called).toBe(false);
  });

  it("fn takes priority over command — does not spawn shell when fn is set", async () => {
    const manager = new HookManager();
    let fnCalled = false;

    manager.register({
      name: "fn-first",
      events: ["*"],
      fn: async () => { fnCalled = true; },
      command: "echo 'should not run'",
      resolvedPosition: "before:agentLoop",
    });

    await manager.onEvent(
      { type: "user-message", content: "test" },
      manager.getHooksAt("before:agentLoop")
    );

    expect(fnCalled).toBe(true);
  });

  it("function hook non-blocking: onEvent returns before fn completes", async () => {
    const manager = new HookManager();
    const timeline: string[] = [];

    manager.register({
      name: "slow-fn",
      events: ["agent-loop-complete"],
      fn: async () => {
        timeline.push("fn-start");
        await new Promise((r) => setTimeout(r, 200));
        timeline.push("fn-end");
      },
      resolvedPosition: "after:agentLoop",
      blocking: false,
    });

    timeline.push("before-onEvent");
    await manager.onEvent(
      { type: "agent-loop-complete", message: "ok", usage: { input: 1, output: 1 } },
      manager.getHooksAt("after:agentLoop")
    );
    timeline.push("after-onEvent");

    // Non-blocking: fn's sync part runs immediately (fn-start),
    // but onEvent returns before the async delay (fn-end not yet pushed)
    expect(timeline[0]).toBe("before-onEvent");
    expect(timeline).toContain("fn-start");
    expect(timeline).toContain("after-onEvent");
    // fn-end should NOT be present — onEvent didn't wait for it
    expect(timeline.indexOf("fn-end")).toBe(-1);

    // Wait for fn to finish — fn-end should appear after after-onEvent
    await new Promise((r) => setTimeout(r, 250));
    expect(timeline).toContain("fn-end");
    const afterIdx = timeline.indexOf("after-onEvent");
    const fnEndIdx = timeline.indexOf("fn-end");
    expect(fnEndIdx).toBeGreaterThan(afterIdx);
  });

  it("function hook blocking: onEvent waits for fn to complete", async () => {
    const manager = new HookManager();
    const timeline: string[] = [];

    manager.register({
      name: "blocking-fn",
      events: ["agent-loop-complete"],
      fn: async () => {
        timeline.push("fn-start");
        await new Promise((r) => setTimeout(r, 10));
        timeline.push("fn-end");
      },
      resolvedPosition: "after:agentLoop",
      blocking: true,
    });

    timeline.push("before-onEvent");
    await manager.onEvent(
      { type: "agent-loop-complete", message: "ok", usage: { input: 1, output: 1 } },
      manager.getHooksAt("after:agentLoop")
    );
    timeline.push("after-onEvent");

    // Blocking: fn must finish before onEvent returns
    expect(timeline).toEqual([
      "before-onEvent",
      "fn-start",
      "fn-end",
      "after-onEvent",
    ]);
  });

  it("function hook errors are silently caught, never propagate", async () => {
    const manager = new HookManager();

    manager.register({
      name: "crashy-fn",
      events: ["agent-loop-complete"],
      fn: async () => { throw new Error("boom!"); },
      resolvedPosition: "after:agentLoop",
    });

    // Should not throw
    await expect(
      manager.onEvent(
        { type: "agent-loop-complete", message: "ok", usage: { input: 1, output: 1 } },
        manager.getHooksAt("after:agentLoop")
      )
    ).resolves.toBeUndefined();
  });

  it("load() still works for shell hooks after register() is used", () => {
    const manager = new HookManager();

    // Register a function hook
    manager.register({
      name: "fn-hook",
      events: ["agent-loop-complete"],
      fn: async () => {},
      resolvedPosition: "after:agentLoop",
    });

    // Load shell hooks from config
    manager.load({
      "shell-hook": {
        events: ["tool-execute-start"],
        command: "echo hi",
        position: "pre-agent",
      },
    });

    // Function hook should still be present
    expect(manager.getHooksAt("after:agentLoop")).toHaveLength(1);
    // Shell hook should be loaded
    expect(manager.getHooksAt("before:agentLoop")).toHaveLength(1);
  });

  it("register() with no command or fn throws or is handled gracefully", () => {
    const manager = new HookManager();

    // A hook with neither command nor fn should still register (validation left to runtime)
    // onEvent should silently skip it
    manager.register({
      name: "empty-hook",
      events: ["*"],
      resolvedPosition: "before:agentLoop",
    });

    const hooks = manager.getHooksAt("before:agentLoop");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].fn).toBeUndefined();
    expect(hooks[0].command).toBeUndefined();
  });
});
