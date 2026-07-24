import { describe, expect, it } from "vitest";
import { ConversationManager } from "../conversation/manager.js";
import { EventPipeline } from "../events/pipeline.js";
import type { PipelineEvent } from "../events/types.js";
import { ContextCompressor } from "./compressor.js";
import { contextMiddleware } from "./middleware.js";

describe("contextMiddleware", () => {
  it("compresses conversation before user messages continue through the pipeline", async () => {
    const manager = new ConversationManager({ model: "test-model" });
    manager.addUserMessage("first message with many words");
    manager.appendToAssistantMessage("first answer with many words");
    manager.addUserMessage("second message with many words");
    manager.appendToAssistantMessage("second answer with many words");

    const compressor = new ContextCompressor({
      maxTokens: 10,
      summarizer: async () => "short summary",
    });
    const emitted: PipelineEvent[] = [];
    const pipeline = new EventPipeline();
    pipeline
      .use(contextMiddleware(manager, compressor, (event) => emitted.push(event)))
      .use("after", async (_event, next) => next());

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "next" };
    }

    await pipeline.run(events());

    expect(emitted).toEqual([
      expect.objectContaining({ type: "context-compressed", method: "summarize" }),
    ]);
  });
});
