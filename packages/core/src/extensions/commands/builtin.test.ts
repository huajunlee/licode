import { describe, it, expect } from "vitest";
import { helpCommand, helpRecipesCommand, helpShortcutsCommand, helpToolsCommand } from "./builtin/help.js";
import { clearCommand } from "./builtin/clear.js";
import { contextCommand } from "./builtin/context.js";
import { memoryCommand, memoryListCommand, memoryAddCommand, memoryDeleteCommand, memoryRestoreCommand, memoryArchiveCommand, memoryPinCommand, memoryUnpinCommand } from "./builtin/memory.js";
import { MemoryStore } from "../../memory/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
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

describe("memory-restore command", () => {
  it("errors when no slug provided", async () => {
    const result = await memoryRestoreCommand.execute([], mockContext());
    expect(result.type).toBe("error");
    expect((result as { message: string }).message).toContain("使用方式");
  });

  it("errors when slug not in archive", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-cmd-"));
    try {
      const result = await memoryRestoreCommand.execute(["user/ghost"], mockContext({ workingDirectory: dir }));
      expect(result.type).toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores an archived memory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-cmd-"));
    try {
      const store = new MemoryStore(`${dir}/.licode/memory`);
      await store.save({
        slug: "user/x",
        type: "user",
        name: "X",
        description: "d",
        content: "c",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
      });
      await store.archive("user/x");
      const result = await memoryRestoreCommand.execute(["user/x"], mockContext({ workingDirectory: dir }));
      expect(result.type).toBe("action");
      expect(await store.load("user/x")).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory-archive command", () => {
  it("lists archived memories (empty message when none)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-arc-cmd-"));
    try {
      const result = await memoryArchiveCommand.execute([], mockContext({ workingDirectory: dir }));
      expect(result.type).toBe("action");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory-pin / memory-unpin commands", () => {
  it("errors when no slug provided", async () => {
    expect((await memoryPinCommand.execute([], mockContext())).type).toBe("error");
    expect((await memoryUnpinCommand.execute([], mockContext())).type).toBe("error");
  });

  it("pins and unpins a memory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-pin-cmd-"));
    try {
      const store = new MemoryStore(`${dir}/.licode/memory`);
      await store.save({ slug: "user/x", type: "user", name: "X", description: "d", content: "c", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" });
      const r1 = await memoryPinCommand.execute(["user/x"], mockContext({ workingDirectory: dir }));
      expect(r1.type).toBe("action");
      expect((await store.load("user/x"))?.pinned).toBe(true);
      const r2 = await memoryUnpinCommand.execute(["user/x"], mockContext({ workingDirectory: dir }));
      expect(r2.type).toBe("action");
      expect((await store.load("user/x"))?.pinned).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
