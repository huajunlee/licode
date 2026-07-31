import type { Message, ToolUseBlock, ToolResultBlock } from "../llm/provider.js";

export interface SummarizerConfig {
  generate: (prompt: string) => Promise<string>;
}

/**
 * Extract the meaningful text of a message: string content verbatim, or the
 * joined text of tool blocks (result content / name+input) - not the raw
 * JSON of the whole message. (Phase 2: replaces the old JSON.stringify.)
 */
function contentText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as (ToolUseBlock | ToolResultBlock)[])
    .map((b) => ("content" in b ? b.content : `${b.name}(${JSON.stringify(b.input)})`))
    .join(" ");
}

export class Summarizer {
  constructor(private config: SummarizerConfig) {}

  async summarize(messages: Message[]): Promise<string> {
    const transcript = messages
      .map((m) => `${m.role}: ${contentText(m)}`)
      .join("\n");

    return this.config.generate(
      `Summarize the following conversation for future context:\n\n${transcript}`
    );
  }
}
