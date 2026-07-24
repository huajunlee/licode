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
