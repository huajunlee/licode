import { describe, it, expect } from "vitest";
import { ConversationManager, SystemPrompt } from "@licode/core";

describe("user message visibility", () => {
  it("getMessages includes the user message immediately after addUserMessage", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Hello?");
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "Hello?" });
  });

  it("getMessages includes the user message before any assistant token arrives", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Question here");
    // Assistant hasn't started yet — user message should already be visible
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("messages array reflects user + partial assistant during streaming", () => {
    const mgr = new ConversationManager({ model: "test" });
    mgr.addUserMessage("Help");
    mgr.appendToAssistantMessage("Sure");
    mgr.appendToAssistantMessage(", let me");
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "Help" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Sure, let me" });
  });
});
