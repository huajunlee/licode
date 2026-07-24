import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../conversation/manager.js";
import { SessionManager } from "./manager.js";
import { recoverLatestSession } from "./recovery.js";

describe("SessionManager", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("persists, lists, and recovers conversations from disk", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-session-"));
    const manager = new SessionManager(path.join(dir, ".licode", "sessions"));
    const conversation = new ConversationManager({
      id: "session-a",
      model: "test-model",
    });
    conversation.addUserMessage("hello");

    await manager.save(conversation);

    const sessions = await manager.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "session-a",
      model: "test-model",
      messageCount: 1,
    });

    const recovered = await recoverLatestSession(manager);
    expect(recovered?.id).toBe("session-a");
    expect(recovered?.getMessages()[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });
});
