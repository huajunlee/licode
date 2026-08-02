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

import type { FileChangeStats } from "./file-change.js";

export interface CompressionTurnInput {
  index: number;
  kind: "must-keep-error" | "must-keep-write" | "candidate" | "fold";
  text: string;
  writeOperation?: "write" | "edit";
  writePath?: string;
  writeStats?: FileChangeStats;
}

export interface CompressionClassification {
  index: number;
  keep: "important" | "normal";
}

export interface CompressionFileChange {
  index: number;
  symbols: string[];
  summary: { kind: string };
}

export interface CompressionAssistResult {
  updatedSummary: string;
  classifications: CompressionClassification[];
  fileChanges: CompressionFileChange[];
}

export interface CompressionAssistantConfig {
  generate: (prompt: string) => Promise<string>;
  summaryMaxTokens?: number;
}

export class CompressionAssistant {
  constructor(private config: CompressionAssistantConfig) {}

  async assist(input: {
    existingSummary: string | null;
    turns: CompressionTurnInput[];
  }): Promise<CompressionAssistResult> {
    const maxTokens = this.config.summaryMaxTokens ?? 2048;
    const prompt = this.buildPrompt(input.existingSummary, input.turns, maxTokens);
    const raw = await this.config.generate(prompt);
    return this.parse(raw);
  }

  private buildPrompt(
    existingSummary: string | null,
    turns: CompressionTurnInput[],
    maxTokens: number
  ): string {
    const lines: string[] = [];
    lines.push("You are a context-compression assistant. Update the rolling summary and classify older turns.");
    lines.push(`Keep updatedSummary under ${maxTokens} tokens; drop the oldest/least-important details if needed.`);
    lines.push("");
    lines.push("Existing summary:");
    lines.push(existingSummary ?? "(none)");
    lines.push("");
    lines.push("Turns:");
    for (const t of turns) {
      let label = `[${t.index}] (${t.kind})`;
      if (t.kind === "must-keep-write" && t.writeOperation) {
        label += ` ${t.writeOperation} ${t.writePath} +${t.writeStats?.added ?? 0}/-${t.writeStats?.removed ?? 0}`;
      }
      lines.push(`${label}: ${t.text}`);
    }
    lines.push("");
    lines.push('Respond with ONLY a JSON object:');
    lines.push('{"updatedSummary":"...","classifications":[{"index":N,"keep":"important"|"normal"}],"fileChanges":[{"index":N,"symbols":["..."],"summary":{"kind":"..."}}]}');
    lines.push("");
    lines.push("Rules:");
    lines.push('- Fold "fold" and "normal" candidate turns into updatedSummary.');
    lines.push('- For each "candidate" turn, set keep "important" (keep verbatim) or "normal" (fold).');
    lines.push('- For each "must-keep-write" turn, produce a fileChanges entry: new core symbols + a one-line intent.');
    lines.push('- For "important" and must-keep turns, add only a brief reference in updatedSummary.');
    return lines.join("\n");
  }

  private parse(raw: string): CompressionAssistResult {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object in compression response");
    }
    let obj: unknown;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      throw new Error(`invalid JSON in compression response: ${(e as Error).message}`);
    }
    const o = obj as Record<string, unknown>;
    if (typeof o.updatedSummary !== "string") {
      throw new Error("compression response missing updatedSummary string");
    }
    const classifications: CompressionClassification[] = Array.isArray(o.classifications)
      ? (o.classifications as Record<string, unknown>[]).map((c) => ({
          index: Number(c.index),
          keep: c.keep === "important" ? "important" : "normal",
        }))
      : [];
    const fileChanges: CompressionFileChange[] = Array.isArray(o.fileChanges)
      ? (o.fileChanges as Record<string, unknown>[]).map((f) => ({
          index: Number(f.index),
          symbols: Array.isArray(f.symbols) ? f.symbols.map(String) : [],
          summary: { kind: String((f.summary as Record<string, unknown> | undefined)?.kind ?? "") },
        }))
      : [];
    return { updatedSummary: o.updatedSummary, classifications, fileChanges };
  }
}
