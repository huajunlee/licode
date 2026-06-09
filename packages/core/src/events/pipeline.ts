import type { PipelineEvent, Middleware } from "./types.js";

export class EventPipeline {
  private middlewares: Middleware[] = [];

  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
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
    if (index >= this.middlewares.length) return;

    const middleware = this.middlewares[index];
    // next() 闭包捕获 index + 1，递归触发链中下一个中间件。
    await middleware(event, async () => {
      await this.executeChain(event, index + 1);
    });
  }
}
