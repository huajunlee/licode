import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventPipeline } from "../events/pipeline.js";
import type { PipelineEvent } from "../events/types.js";
import { MemoryExtractor } from "./extractor.js";
import { memoryMiddleware } from "./middleware.js";
import { MemoryStore } from "./store.js";

describe("memoryMiddleware", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("extracts explicit preferences from user messages and stores them", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-memory-mw-"));
    const store = new MemoryStore(path.join(dir, ".licode", "memory"));
    const pipeline = new EventPipeline();
    pipeline.use(memoryMiddleware(new MemoryExtractor(), store));

    async function* events(): AsyncIterable<PipelineEvent> {
      yield {
        type: "user-message",
        content: "Remember that I prefer pnpm for package management.",
      };
    }

    await pipeline.run(events());

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("prefer pnpm");
  });
});
