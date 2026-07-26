import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventPipeline } from "../events/pipeline.js";
import type { PipelineEvent } from "../events/types.js";
import { RegexMemoryExtractor } from "./extractor-regex.js";
import { memoryMiddleware } from "./middleware.js";
import { MemoryStore } from "./store.js";

describe("memoryMiddleware (deprecated)", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("extracts preferences from user messages and stores as Memory files", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-mw-"));
    const store = new MemoryStore(path.join(dir, ".licode", "memory"));
    const pipeline = new EventPipeline();
    pipeline.use(memoryMiddleware(new RegexMemoryExtractor(), store));

    async function* events(): AsyncIterable<PipelineEvent> {
      yield {
        type: "user-message",
        content: "Remember that I prefer pnpm for package management.",
      };
    }

    await pipeline.run(events());

    // New API: listAll returns Memory[]
    const entries = await store.listAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user");
    expect(entries[0].content).toContain("prefer pnpm");
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("creates MEMORY.md index when memories are saved via middleware", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-mw-"));
    const store = new MemoryStore(path.join(dir, ".licode", "memory"));
    const pipeline = new EventPipeline();
    pipeline.use(memoryMiddleware(new RegexMemoryExtractor(), store));

    async function* events(): AsyncIterable<PipelineEvent> {
      yield {
        type: "user-message",
        content: "My name is Alice.",
      };
    }

    await pipeline.run(events());

    const indexContent = await store.loadIndex();
    expect(indexContent).toContain("user/identity");
    expect(indexContent).toContain("Alice");
  });
});
