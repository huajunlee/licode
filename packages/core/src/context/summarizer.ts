import type { Message } from "../llm/provider.js";

export interface SummarizerConfig {
  generate: (prompt: string) => Promise<string>;
}

export class Summarizer {
  constructor(private config: SummarizerConfig) {}

  async summarize(messages: Message[]): Promise<string> {
    const transcript = messages
      .map((message) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return `${message.role}: ${content}`;
      })
      .join("\n");

    return this.config.generate(
      `Summarize the following conversation for future context:\n\n${transcript}`
    );
  }
}
