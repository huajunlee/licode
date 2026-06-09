import { describe, it, expect, vi } from "vitest";
import { EventPipeline } from "./pipeline.js";
import type { PipelineEvent, Middleware } from "./types.js";

describe("EventPipeline", () => {
  it("executes middlewares in order", async () => {
    const order: string[] = [];
    const pipeline = new EventPipeline();

    pipeline.use(async (_event, next) => {
      order.push("a");
      await next();
      order.push("a-after");
    });

    pipeline.use(async (_event, next) => {
      order.push("b");
      await next();
      order.push("b-after");
    });

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "test" };
    }

    await pipeline.run(events());

    expect(order).toEqual(["a", "b", "b-after", "a-after"]);
  });

  it("middleware can intercept by not calling next", async () => {
    const reached: string[] = [];
    const pipeline = new EventPipeline();

    pipeline.use(async (_event, _next) => {
      reached.push("interceptor");
      // does not call next()
    });

    pipeline.use(async (_event, next) => {
      reached.push("blocked");
      await next();
    });

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "test" };
    }

    await pipeline.run(events());
    expect(reached).toEqual(["interceptor"]);
  });

  it("processes multiple events", async () => {
    const processed: string[] = [];
    const pipeline = new EventPipeline();

    pipeline.use(async (event, next) => {
      processed.push(event.type);
      await next();
    });

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "a" };
      yield { type: "llm-token", text: "x", index: 0 };
      yield {
        type: "stream-complete",
        messages: [],
      };
    }

    await pipeline.run(events());
    expect(processed).toEqual([
      "user-message",
      "llm-token",
      "stream-complete",
    ]);
  });

  it("chain returns this for fluent API", () => {
    const pipeline = new EventPipeline();
    const result = pipeline
      .use(async (_e, n) => {
        await n();
      })
      .use(async (_e, n) => {
        await n();
      });
    expect(result).toBe(pipeline);
  });
});
