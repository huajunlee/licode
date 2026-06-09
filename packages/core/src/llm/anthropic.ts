import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  Message,
  SystemMessage,
} from "./provider.js";
import { TokenCounter } from "./token-counter.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly maxContextTokens = 200_000;

  private client: Anthropic;
  private tokenCounter = new TokenCounter();

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params = this.toAnthropicParams(req);
    const res = await this.client.messages.create({
      ...params,
      stream: false,
    });

    const content = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      content,
      usage: {
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
      },
      stopReason: res.stop_reason ?? "end_turn",
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const params = this.toAnthropicParams(req);
    let tokenIndex = 0;

    try {
      const stream = this.client.messages.stream({
        ...params,
        stream: true,
      });

      for await (const event of stream) {
        const chunk = this.toStreamChunk(event, tokenIndex);
        if (chunk) {
          if (chunk.type === "token") {
            tokenIndex++;
          }
          yield chunk;
        }
      }

      const finalMessage = await stream.finalMessage();
      if (finalMessage) {
        yield {
          type: "stop",
          stopReason: finalMessage.stop_reason ?? "end_turn",
          usage: {
            input: finalMessage.usage.input_tokens,
            output: finalMessage.usage.output_tokens,
          },
        };
      }
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  countTokens(messages: Message[]): number {
    return this.tokenCounter.estimateMessages(messages);
  }

  private toAnthropicParams(
    req: ChatRequest
  ): Omit<Anthropic.MessageCreateParams, "stream"> {
    const system = this.extractSystem(req.messages);
    const messages = this.toAnthropicMessages(req.messages);

    const params: Omit<Anthropic.MessageCreateParams, "stream"> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
      system: system || undefined,
    };

    if (req.temperature !== undefined) {
      params.temperature = req.temperature;
    }

    // extensions 透传 Anthropic 特有参数（thinking, cache_control 等）。
    // Phase 1 仅做透传，Phase 3 前不定义具体类型。
    const extensions = req.extensions ?? {};
    for (const [key, value] of Object.entries(extensions)) {
      if (key === "thinking" && typeof value === "object") {
        (params as Record<string, unknown>)["thinking"] = value;
      }
      if (key === "cache_control" && typeof value === "object") {
        (params as Record<string, unknown>)["cache_control"] = value;
      }
    }

    return params;
  }

  private extractSystem(messages: Message[]): string {
    const systemMsgs = messages.filter(
      (m): m is SystemMessage => m.role === "system"
    );
    return systemMsgs.map((m) => m.content).join("\n\n");
  }

  private toAnthropicMessages(
    messages: Message[]
  ): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "user") {
          return {
            role: "user" as const,
            content: m.content,
          };
        }
        return {
          role: "assistant" as const,
          content: m.content,
        };
      });
  }

  private toStreamChunk(
    event: unknown,
    index: number
  ): StreamChunk | null {
    const e = event as Record<string, unknown>;

    // Only text_delta produces visible tokens; thinking_delta captures
    // extended thinking content for collapsible display in the CLI.
    // All other SSE event types are internal protocol events we silently skip.
    if (e.type === "content_block_delta") {
      const delta = e.delta as
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | undefined;

      if (delta?.type === "text_delta" && delta.text) {
        return { type: "token", text: delta.text, index };
      }
      if (delta?.type === "thinking_delta" && delta.thinking) {
        return { type: "thinking", text: delta.thinking };
      }
      // signature_delta: internal, silently skip
      return null;
    }

    if (e.type === "content_block_start") {
      const contentBlock = e.content_block as
        | { type: string; name?: string }
        | undefined;
      if (contentBlock?.type === "tool_use") {
        return null;
      }
      return null;
    }

    if (e.type === "message_start") {
      const message = e.message as { usage?: { input_tokens?: number } } | undefined;
      return null;
    }

    if (e.type === "message_delta") {
      const delta = e.delta as { stop_reason?: string } | undefined;
      return null;
    }

    return null;
  }
}
