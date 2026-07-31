import { describe, it, expect } from "vitest";
import { CommandRouter } from "./router.js";
import type { SlashCommand, CommandContext, CommandResult } from "./registry.js";

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    conversation: {
      clear() {},
      getTokenCount() {
        return 5000;
      },
      getMessageCount() {
        return 12;
      },
      getBudgetInfo() {
        return { contextWindow: 0, outputReserve: 0, used: 5000, remaining: 0 };
      },
      id: "session-1",
      metadata: { model: "test-model", createdAt: "", updatedAt: "" },
    } as unknown as CommandContext["conversation"],
    toolRegistry: {} as CommandContext["toolRegistry"],
    workingDirectory: "/tmp",
    ...overrides,
  };
}

describe("CommandRouter", () => {
  it("routes /help to the registered help command", async () => {
    const router = new CommandRouter();

    const helpCmd: SlashCommand = {
      name: "help",
      description: "List all commands",
      execute: async () => ({ type: "action", message: "/help — List all commands" }),
    };

    router.register(helpCmd);

    const result = await router.route("/help", mockContext());
    expect(result).not.toBeNull();
    expect(result!.type).toBe("action");
    expect((result as { message: string }).message).toContain("/help");
  });

  it("returns error for unknown commands", async () => {
    const router = new CommandRouter();

    const result = await router.route("/nonexistent", mockContext());
    expect(result).not.toBeNull();
    expect(result!.type).toBe("error");
    expect((result as { message: string }).message).toContain("Unknown command");
  });

  it("returns null for non-command input (no slash)", async () => {
    const router = new CommandRouter();

    const result = await router.route("普通对话文本", mockContext());
    expect(result).toBeNull();
  });

  it("returns null for empty input", async () => {
    const router = new CommandRouter();

    const result = await router.route("", mockContext());
    expect(result).toBeNull();
  });

  it("parses command arguments", async () => {
    const router = new CommandRouter();

    const echoCmd: SlashCommand = {
      name: "echo",
      description: "Echo arguments",
      execute: async (args) => ({ type: "action", message: args.join(" ") }),
    };

    router.register(echoCmd);

    const result = await router.route("/echo hello world", mockContext());
    expect(result).not.toBeNull();
    expect((result as { message: string }).message).toBe("hello world");
  });

  it("registers multiple commands via registerAll", async () => {
    const router = new CommandRouter();

    router.registerAll([
      {
        name: "a",
        description: "Command A",
        execute: async () => ({ type: "action", message: "A" }),
      },
      {
        name: "b",
        description: "Command B",
        execute: async () => ({ type: "action", message: "B" }),
      },
    ]);

    expect(await router.route("/a", mockContext())).not.toBeNull();
    expect(await router.route("/b", mockContext())).not.toBeNull();
  });

  it("list returns all registered commands", () => {
    const router = new CommandRouter();

    router.register({
      name: "test",
      description: "A test command",
      execute: async () => ({ type: "action", message: "ok" }),
    });

    const cmds = router.list();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe("test");
    expect(cmds[0].description).toBe("A test command");
  });

  it("supports prompt-type command results", async () => {
    const router = new CommandRouter();

    const reviewCmd: SlashCommand = {
      name: "review",
      description: "Review code",
      execute: async () => ({ type: "prompt", content: "Please review my code changes." }),
    };

    router.register(reviewCmd);

    const result = await router.route("/review", mockContext());
    expect(result).not.toBeNull();
    expect(result!.type).toBe("prompt");
    expect((result as { content: string }).content).toBe("Please review my code changes.");
  });
});
