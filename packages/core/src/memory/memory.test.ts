import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { MemoryLoader } from "./loader.js";
import { MemoryStore } from "./store.js";

describe("MemoryStore and MemoryLoader", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("stores markdown memories and injects them into the system prompt", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-"));
    const store = new MemoryStore(path.join(dir, ".licode", "memory"));
    await store.save({
      id: "preferences",
      title: "User preferences",
      content: "Always answer in Chinese.",
      tags: ["preference"],
    });

    const systemPrompt = new SystemPrompt();
    const loader = new MemoryLoader(store);
    await loader.loadInto(systemPrompt);

    const memoryLayer = systemPrompt
      .getLayers()
      .find((layer) => layer.name === "memory");
    expect(memoryLayer?.content).toContain("Always answer in Chinese.");
  });
});
