import { describe, it, expect } from "vitest";
import { helpCommand, helpRecipesCommand, helpShortcutsCommand, helpToolsCommand } from "./builtin/help.js";
import { clearCommand } from "./builtin/clear.js";
import { contextCommand } from "./builtin/context.js";
import { memoryCommand, memoryListCommand, memoryAddCommand, memoryDeleteCommand } from "./builtin/memory.js";
import type { CommandContext } from "./registry.js";

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  let cleared = false;
  return {
    conversation: {
      id: "test-session-123",
      metadata: { model: "test-model", createdAt: "", updatedAt: "" },
      clear() {
        cleared = true;
      },
      _cleared() {
        return cleared;
      },
      getTokenCount() {
        return 5000;
      },
      getMessageCount() {
        return 12;
      },
      getBudgetInfo() {
        return { contextWindow: 0, outputReserve: 0, used: 5000, remaining: 0 };
      },
    } as unknown as CommandContext["conversation"],
    toolRegistry: {} as CommandContext["toolRegistry"],
    workingDirectory: "/tmp",
    ...overrides,
  };
}

describe("help command", () => {
  it("returns formatted command list with descriptions", async () => {
    const result = await helpCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("/help");
    expect((result as { message: string }).message).toContain("/clear");
    expect((result as { message: string }).message).toContain("/context");
    expect((result as { message: string }).message).toContain("/memory-list");
    expect((result as { message: string }).message).toContain("/memory-add");
    expect((result as { message: string }).message).toContain("/memory-delete");
  });

  it("shows recipes with sub-command arg", async () => {
    const result = await helpCommand.execute(["recipes"], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("场景 Recipes");
  });
});

describe("help-recipes command", () => {
  it("returns recipes list", async () => {
    const result = await helpRecipesCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("场景 Recipes");
    expect((result as { message: string }).message).toContain("code-review");
  });
});

describe("help-shortcuts command", () => {
  it("returns shortcuts list", async () => {
    const result = await helpShortcutsCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("快捷键速查");
  });
});

describe("help-tools command", () => {
  it("returns tools list", async () => {
    const result = await helpToolsCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("内置工具速查");
  });
});

describe("clear command", () => {
  it("clears conversation history and returns success message", async () => {
    const ctx = mockContext();
    const result = await clearCommand.execute([], ctx);
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("cleared");
  });
});

describe("context command", () => {
  it("returns token usage and session info", async () => {
    const result = await contextCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    const msg = (result as { message: string }).message;
    expect(msg).toContain("test-model");
    expect(msg).toContain("5000");
    expect(msg).toContain("12");
    expect(msg).toContain("test-session-123");
  });
});

describe("memory command", () => {
  it("returns empty memory message when no memories exist", async () => {
    const result = await memoryCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("没有存储的记忆");
  });

  it("returns error for unknown sub-command", async () => {
    const result = await memoryCommand.execute(["unknown"], mockContext());
    expect(result.type).toBe("error");
  });
});

describe("memory-list command", () => {
  it("lists memories (empty)", async () => {
    const result = await memoryListCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("没有存储的记忆");
  });
});

describe("memory-add command", () => {
  it("errors when no content provided", async () => {
    const result = await memoryAddCommand.execute([], mockContext());
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("使用方式");
  });
});

describe("memory-delete command", () => {
  it("errors when no slug provided", async () => {
    const result = await memoryDeleteCommand.execute([], mockContext());
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("使用方式");
  });
});
