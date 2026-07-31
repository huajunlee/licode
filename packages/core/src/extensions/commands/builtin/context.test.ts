import { describe, expect, it } from "vitest";
import { contextCommand } from "./context.js";
import { ConversationManager } from "../../../conversation/manager.js";

describe("/context command", () => {
  it("renders token percentage when window is published", async () => {
    const mgr = new ConversationManager({ model: "m" });
    mgr.setContextBudget({ contextWindow: 200000, outputReserve: 8192 });
    mgr.replaceMessages([
      { role: "user", content: "hi", timestamp: new Date().toISOString() },
      { role: "assistant", content: "hello", timestamp: new Date().toISOString() },
    ]);
    const res = await contextCommand.execute([], {
      conversation: mgr,
      workingDirectory: process.cwd(),
    } as never);
    const msg = (res as { message: string }).message;
    expect(msg).toMatch(/%\s*\(/); // e.g. "0% (1k/200k)"
    expect(msg).toContain("Window: 200000");
  });
});
