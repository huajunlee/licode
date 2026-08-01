import * as fs from "node:fs";
import * as path from "node:path";
import { AnthropicProvider } from "../llm/anthropic.js";
import { pruneRecallMessages } from "./recall.js";
import { formatLocalDate } from "../util/date.js";
import type { LLMProvider, Message } from "../llm/provider.js";
import type { MemoryStore } from "./store.js";
import type { Memory, MemoryType } from "./types.js";
import type { MemoryAction } from "./store.js";

/**
 * Explicit user instructions that always trigger extraction immediately,
 * bypassing the cooldown window.
 */
const EXPLICIT_INSTRUCTIONS = ["记住", "记一下", "不要忘记", "别忘了", "remember"];

/** Question patterns that should NOT trigger extraction. */
const QUESTION_PATTERNS = [
  /^什么/, /^啥/, /^谁/, /^怎么/, /^哪/, /^多少/, /^几/,
  /^what/i, /^who/i, /^how/i, /^where/i, /^when/i, /^why/i,
  /[？?]$/, /吗$/, /呢$/,
];

const MEMORY_TYPES: readonly string[] = ["user", "feedback", "project", "reference"];
const MEMORY_ACTIONS: readonly string[] = ["create", "update", "append"];

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGES = 50;

function isQuestionLike(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  for (const p of QUESTION_PATTERNS) {
    if (p.test(trimmed)) return true;
  }
  return false;
}

function containsExplicitInstruction(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of EXPLICIT_INSTRUCTIONS) {
    if (lower.includes(kw.toLowerCase())) return true;
  }
  return false;
}

export interface MemoryExtractorConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Minimum interval between two extractions. Default 5 minutes. */
  cooldownMs?: number;
}

export interface ShouldExtractOptions {
  /** Epoch ms of the last extraction attempt. 0 = never extracted. */
  lastExtractedAt: number;
  /** Current time in epoch ms (defaults to Date.now(), injectable for tests). */
  now?: number;
}

export interface ExtractOptions {
  /** Only include messages with timestamp > sinceMs in the prompt. */
  sinceMs?: number;
  /** Cap on how many recent messages are sent to the LLM. Default 50. */
  maxMessages?: number;
}

/**
 * LLM-based memory extractor.
 *
 * After each agent loop, a lightweight pre-check ({@link shouldExtract})
 * decides whether an LLM call is warranted; {@link extract} then asks the
 * LLM to create/update/append memory files based on the recent conversation
 * and the full content of existing memories.
 */
export class MemoryExtractor {
  private llm: AnthropicProvider;
  private model: string;
  private cooldownMs: number;

  constructor(config?: MemoryExtractorConfig) {
    const apiKey = config?.apiKey
      ?? process.env.ANTHROPIC_API_KEY
      ?? process.env.OPENAI_API_KEY
      ?? "";
    const baseUrl = config?.baseUrl
      ?? process.env.ANTHROPIC_BASE_URL
      ?? process.env.OPENAI_BASE_URL;
    this.model = config?.model ?? "deepseek-chat";
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.llm = new AnthropicProvider({ apiKey, baseUrl });
  }

  /**
   * Lightweight pre-check that does NOT call any LLM.
   * Returns `false` → skip extraction entirely (zero token cost).
   * Returns `true` → proceed to {@link extract} (LLM makes the final call).
   *
   * Gate rules (in order):
   * 1. No new user messages since `lastExtractedAt` → false
   * 2. Any new message contains an explicit instruction ("记住" etc.) → true (bypasses cooldown)
   * 3. All new user messages look like questions → false
   * 4. Inside the cooldown window → false
   * 5. Otherwise → true
   */
  shouldExtract(
    messages: readonly Message[],
    options: ShouldExtractOptions
  ): boolean {
    if (!messages || messages.length === 0) return false;

    const { lastExtractedAt } = options;
    const now = options.now ?? Date.now();

    const newUserMessages = messages.filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        Date.parse(m.timestamp) > lastExtractedAt
    );
    if (newUserMessages.length === 0) return false;

    // Explicit instructions always trigger immediately
    for (const msg of newUserMessages) {
      if (containsExplicitInstruction(msg.content as string)) return true;
    }

    // All new user messages are questions → nothing worth remembering
    if (newUserMessages.every((m) => isQuestionLike(m.content as string))) {
      return false;
    }

    // Cooldown window
    if (now - lastExtractedAt < this.cooldownMs) return false;

    return true;
  }

  /**
   * Call the LLM to analyze conversation messages and extract memories.
   * Results are persisted via the given {@link MemoryStore}, honouring the
   * LLM's per-item action (create / update / append).
   *
   * Errors are silently caught — extraction is best-effort and never
   * blocks the user.
   */
  async extract(
    messages: readonly Message[],
    store: MemoryStore,
    options?: ExtractOptions
  ): Promise<void> {
    try {
      const existingMemories = await store.listAll();
      const indexContent = await store.loadIndex();

      const recent = this.selectMessages(messages, options);
      const conversationText = this.formatMessages(pruneRecallMessages([...recent]));

      const prompt = this.buildPrompt(indexContent, existingMemories, conversationText, new Date());

      const response = await this.llm.chat({
        messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
        model: this.model,
        maxTokens: 2048,
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
        await store.save(memory, item.action);
      }
    } catch (err) {
      // Extraction is best-effort — never propagate errors.
      // Log to stderr AND write to a file so the error is visible even
      // when the TUI captures console output.
      const message = err instanceof Error ? err.message : String(err);
      const detail = err instanceof Error ? (err as Error).stack ?? message : message;
      console.error("[MemoryExtractor] Extraction failed:", message);

      // Also write to .licode/logs/extraction-errors.log so errors are
      // visible even when the TUI captures console output.
      // (Not inside .licode/memory/ — wouldn't affect memory reads,
      // but it's cleaner to keep logs separate.)
      try {
        // Access the store's private dir field via type coercion —
        // TypeScript private is compile-time only.
        const storeDir: string = (store as unknown as Record<string, unknown>).dir as string;
        if (storeDir) {
          // storeDir is e.g. /project/.licode/memory, derive logs dir from it
          const licodeDir = path.dirname(storeDir); // → /project/.licode
          const logDir = path.join(licodeDir, "logs");
          fs.mkdirSync(logDir, { recursive: true });
          const logPath = path.join(logDir, "extraction-errors.log");
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
   * Select messages for the prompt: only those newer than `sinceMs`
   * (all messages when omitted), capped at the most recent `maxMessages`.
   */
  private selectMessages(
    messages: readonly Message[],
    options?: ExtractOptions
  ): readonly Message[] {
    let selected = messages;
    if (options?.sinceMs !== undefined) {
      const sinceMs = options.sinceMs;
      selected = selected.filter(
        (m) => "timestamp" in m && Date.parse(m.timestamp) > sinceMs
      );
    }
    const cap = options?.maxMessages ?? MAX_MESSAGES;
    return selected.slice(-cap);
  }

  /**
   * Build the LLM prompt for memory extraction.
   * Carries the full content of all existing memories so the LLM can
   * decide to update them (single tool-less call — the LLM cannot Read).
   */
  private buildPrompt(
    indexContent: string,
    existingMemories: readonly Memory[],
    conversationText: string,
    now: Date
  ): string {
    let existingSection: string;
    if (existingMemories.length === 0) {
      existingSection = "(No existing memories yet.)";
    } else {
      const parts: string[] = [];
      if (indexContent) parts.push(indexContent.trim());
      for (const m of existingMemories) {
        parts.push(
          `### ${m.slug}\nname: ${m.name}\ndescription: ${m.description}\ncontent:\n${m.content}`
        );
      }
      existingSection = parts.join("\n\n");
    }

    return [
      "Analyze the most recent conversation messages and update the persistent memory system.",
      `今天是 ${formatLocalDate(now)}。`,
      "",
      "## Existing memories (index + full content)",
      existingSection,
      "",
      "## Recent conversation",
      conversationText,
      "",
      "## Instructions",
      "",
      "从对话中识别值得跨会话保存的信息，输出 JSON 数组（无新信息则输出 []）：",
      '[{"action":"create|update|append","slug":"<type>/<kebab-case>","type":"user|feedback|project|reference","name":"简短名称","description":"一句话描述","content":"完整正文"}]',
      "",
      "Rules:",
      "- create：新主题；update：改写已有文件正文（slug 必须匹配现有文件）；append：向已有文件补充新段落",
      "- 新信息与现有记忆矛盾时，必须用 update 重写，以最新信息为准——禁止让矛盾并存",
      "- feedback 类型只记录用户明确纠正过的行为或确认过的非显然做法，content 中必须包含规则、原因（Why:）和适用范围（How to apply:）",
      "- 不要保存：代码模式与架构、git 历史、调试方案、当前任务进度、一次性问答、琐碎闲聊",
      "- 用户在提问而非陈述事实时，跳过",
      "- 把 description 与 content 中的相对日期转换为绝对日期；精确词（昨天/上周/去年）转确切日期，模糊词（最近/前阵子）转大致范围（如\"2026年7月前后\")",
      "- 只使用上述最近对话中的内容；不要臆测或补充对话中不存在的信息",
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
   * Returns empty array on any parse failure; individual items with an
   * invalid action/type/slug are dropped while the rest are kept.
   */
  private parseResponse(raw: string): Array<{
    action: MemoryAction;
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
          MEMORY_ACTIONS.includes(item.action) &&
          typeof item.type === "string" &&
          MEMORY_TYPES.includes(item.type) &&
          typeof item.slug === "string" &&
          item.slug.startsWith(`${item.type}/`) &&
          typeof item.name === "string" &&
          typeof item.description === "string" &&
          typeof item.content === "string"
      );
    } catch {
      return [];
    }
  }
}
