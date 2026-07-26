import * as fs from "node:fs";
import * as path from "node:path";
import { AnthropicProvider } from "../llm/anthropic.js";
import type { LLMProvider, Message } from "../llm/provider.js";
import type { MemoryStore } from "./store.js";
import type { Memory, MemoryType } from "./types.js";

/**
 * Keyword triggers for the lightweight `shouldExtract()` pre-check.
 * These run BEFORE any LLM call — returning false means zero token cost.
 */
const TRIGGER_KEYWORDS_CN = [
  "记住", "我叫", "我是", "我喜欢", "我偏好", "我爱", "我习惯",
  "我想", "我使用", "我用", "我的", "我在", "我最近", "我以后",
];

const TRIGGER_KEYWORDS_EN = [
  "remember", "my name is", "i am a", "i am an", "i prefer",
  "i like", "i love", "i use", "i work", "i want", "i need",
  "call me", "i'm a", "i'm an",
];

/** Question patterns that should NOT trigger extraction. */
const QUESTION_PATTERNS = [
  /^什么/, /^啥/, /^谁/, /^怎么/, /^哪/, /^多少/, /^几/,
  /^what/i, /^who/i, /^how/i, /^where/i, /^when/i, /^why/i,
  /[？?]$/, /吗$/, /呢$/,
];

function isQuestionLike(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  for (const p of QUESTION_PATTERNS) {
    if (p.test(trimmed)) return true;
  }
  return false;
}

/**
 * LLM-based memory extractor (Step 2).
 *
 * Replaces the old regex-based {@link RegexMemoryExtractor}.
 * Uses a small LLM call AFTER each agent loop to analyze the full
 * conversation and identify information worth remembering.
 */
export class MemoryExtractor {
  private llm: AnthropicProvider;

  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    const apiKey = config?.apiKey
      ?? process.env.ANTHROPIC_API_KEY
      ?? process.env.OPENAI_API_KEY
      ?? "";
    const baseUrl = config?.baseUrl
      ?? process.env.ANTHROPIC_BASE_URL
      ?? process.env.OPENAI_BASE_URL;
    this.llm = new AnthropicProvider({ apiKey, baseUrl });
  }

  /**
   * Lightweight pre-check that does NOT call any LLM.
   * Returns `false` → skip extraction entirely (zero token cost).
   * Returns `true` → proceed to {@link extract} (LLM makes the final call).
   */
  shouldExtract(messages: readonly Message[]): boolean {
    if (!messages || messages.length === 0) return false;

    // Check only user messages for trigger keywords
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content !== "string") continue;

      // Exclude questions
      if (isQuestionLike(content)) continue;

      const lower = content.toLowerCase();
      for (const kw of TRIGGER_KEYWORDS_CN) {
        if (content.includes(kw)) return true;
      }
      for (const kw of TRIGGER_KEYWORDS_EN) {
        if (lower.includes(kw)) return true;
      }
    }

    return false;
  }

  /**
   * Call the LLM to analyze conversation messages and extract memories.
   * Results are persisted via the given {@link MemoryStore}.
   *
   * Errors are silently caught — extraction is best-effort and never
   * blocks the user.
   */
  async extract(messages: readonly Message[], store: MemoryStore): Promise<void> {
    try {
      const indexContent = await store.loadIndex();
      const conversationText = this.formatMessages(messages);

      const prompt = this.buildPrompt(indexContent, conversationText);

      const response = await this.llm.chat({
        messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
        model: "deepseek-chat",
        maxTokens: 1024,
        temperature: 0,
      });

      const parsed = this.parseResponse(response.content);
      for (const item of parsed) {
        const now = new Date().toISOString();
        const memory: Memory = {
          slug: item.slug,
          type: item.type as MemoryType,
          name: item.name,
          description: item.description,
          content: item.content,
          createdAt: now,
          updatedAt: now,
        };
        await store.save(memory);
      }
    } catch (err) {
      // Extraction is best-effort — never propagate errors.
      // Log to stderr AND write to a file so the error is visible even
      // when the TUI captures console output.
      const message = err instanceof Error ? err.message : String(err);
      const detail = err instanceof Error ? (err as Error).stack ?? message : message;
      console.error("[MemoryExtractor] Extraction failed:", message);

      // Also write to .licode/memory/extraction-errors.log so errors are
      // visible even when the TUI captures console output.
      try {
        // Access the store's private dir field via type coercion —
        // TypeScript private is compile-time only.
        const storeDir: string = (store as unknown as Record<string, unknown>).dir as string;
        if (storeDir) {
          const logPath = path.join(storeDir, "extraction-errors.log");
          const timestamp = new Date().toISOString();
          const entry = `[${timestamp}] ${detail}\n`;
          fs.appendFileSync(logPath, entry, "utf-8");
        }
      } catch {
        // If we can't write the log, at least we tried
      }
    }
  }

  /**
   * Build the LLM prompt for memory extraction.
   */
  private buildPrompt(indexContent: string, conversationText: string): string {
    const indexSection = indexContent
      ? `## Existing memories (match slug if updating an existing topic)\n${indexContent}\n`
      : "(No existing memories yet.)\n";

    return [
      "Analyze this conversation and extract information worth remembering.",
      "",
      indexSection,
      "## Recent conversation",
      conversationText,
      "## Instructions",
      "Identify facts about the user (preferences, identity, role, habits, knowledge)",
      "or project decisions that should be persisted across sessions.",
      "",
      "Output ONLY a JSON array (empty if nothing new):",
      '[{"action":"create|update|append","slug":"user/food-preferences","type":"user","name":"Food Preferences","description":"one-line summary","content":"full detail"}]',
      "",
      "Rules:",
      "- Use 'create' for new topics, 'update' to replace, 'append' to add to existing",
      "- Match existing slugs when updating the same topic",
      "- Don't extract trivial chitchat or one-off questions",
      "- If the user is asking a question (not stating a fact), skip it",
      "- Types: user (personal info/preferences), feedback, project, reference",
    ].join("\n");
  }

  /**
   * Format conversation messages into a readable text block.
   */
  private formatMessages(messages: readonly Message[]): string {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const label = m.role === "user" ? "User" : "Assistant";
        const content = typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);
        return `${label}: ${content}`;
      })
      .join("\n\n");
  }

  /**
   * Parse LLM response into structured memory items.
   * Returns empty array on any parse failure.
   */
  private parseResponse(raw: string): Array<{
    action: string;
    slug: string;
    type: string;
    name: string;
    description: string;
    content: string;
  }> {
    try {
      // Extract JSON from possible markdown code fences
      let json = raw.trim();
      const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) {
        json = fenceMatch[1].trim();
      }

      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item: any) =>
          item &&
          typeof item.action === "string" &&
          typeof item.slug === "string" &&
          typeof item.content === "string"
      );
    } catch {
      return [];
    }
  }
}
