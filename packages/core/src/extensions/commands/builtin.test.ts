import { describe, it, expect } from "vitest";
import { helpCommand } from "./builtin/help.js";
import { clearCommand } from "./builtin/clear.js";
import { contextCommand } from "./builtin/context.js";
import { memoryCommand } from "./builtin/memory.js";
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
    expect((result as { message: string }).message).toContain("/memory");
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
  it("returns placeholder message", async () => {
    const result = await memoryCommand.execute([], mockContext());
    expect(result.type).toBe("action");
    expect((result as { message: string }).message).toContain("future update");
  });
});
