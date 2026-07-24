import type { PipelineEvent, Middleware } from "./types.js";

export interface MiddlewareEntry {
  name: string;
  mw: Middleware;
}

let anonymousCounter = 0;

export class EventPipeline {
  private entries: MiddlewareEntry[] = [];

  use(mw: Middleware): this;
  use(name: string, mw: Middleware): this;
  use(nameOrMw: string | Middleware, mw?: Middleware): this {
    if (typeof nameOrMw === "string" && mw) {
      this.entries.push({ name: nameOrMw, mw });
    } else if (typeof nameOrMw === "function") {
      this.entries.push({ name: `anon_${++anonymousCounter}`, mw: nameOrMw });
    }
    return this;
  }

  listMiddleware(): MiddlewareEntry[] {
    return this.entries;
  }

  async run(events: AsyncIterable<PipelineEvent>): Promise<void> {
    for await (const event of events) {
      await this.executeChain(event, 0);
    }
  }

  /**
   * 洋葱模型：每个中间件收到事件后，可以决定是否调用 next()
   * 传递给下一个中间件。不调用 next() = 拦截事件。
   */
  private async executeChain(
    event: PipelineEvent,
    index: number
  ): Promise<void> {
    if (index >= this.entries.length) return;

    const { mw: middleware } = this.entries[index];
    // next() 闭包捕获 index + 1，递归触发链中下一个中间件。
    await middleware(event, async () => {
      await this.executeChain(event, index + 1);
    });
  }
}
