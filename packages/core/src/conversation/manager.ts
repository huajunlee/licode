import { v4 as uuidv4 } from "uuid";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, TokenUsage, ToolUseBlock, AssistantMessage } from "../llm/provider.js";
import type { ToolResult } from "../tools/types.js";
import { SystemPrompt } from "./system-prompt.js";
import { TokenCounter } from "../llm/token-counter.js";

export interface ConversationMetadata {
  title?: string;
  tags?: string[];
  model: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  totalTokens: number;
  messageCount: number;
  systemPromptLayers: string[];
  messages: Message[];
  metadata: ConversationMetadata;
}

const DEFAULT_SESSIONS_DIR = ".licode/sessions";

export class ConversationManager {
  readonly id: string;
  private messages: Message[] = [];
  // Public so CLI can inject layers loaded from disk after construction.
  systemPrompt: SystemPrompt;
  metadata: ConversationMetadata;
  private tokenCounter = new TokenCounter();

  constructor(config: {
    id?: string;
    model: string;
    systemPrompt?: SystemPrompt;
  }) {
    this.id = config.id ?? uuidv4();
    this.systemPrompt = config.systemPrompt ?? new SystemPrompt();
    const now = new Date().toISOString();
    this.metadata = {
      model: config.model,
      createdAt: now,
      updatedAt: now,
    };
  }

  addUserMessage(content: string): void {
    this.messages.push({
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });
    this.metadata.updatedAt = new Date().toISOString();
  }

  /** Phase 2: add tool_use + tool_result message pair to history */
  addToolMessages(
    toolUses: ToolUseBlock[],
    results: ToolResult[]
  ): void {
    const now = new Date().toISOString();

    this.messages.push({
      role: "assistant",
      content: toolUses,
      timestamp: now,
    });

    this.messages.push({
      role: "user",
      content: results.map((r, i) => ({
        tool_use_id: toolUses[i].id,
        content: r.status === "success" ? r.content : r.error,
        is_error: r.status === "error",
      })),
      timestamp: now,
    });

    this.metadata.updatedAt = now;
  }

  /** Phase 2: find the most recent assistant-or-tool-use message */
  getLastAssistantMessage(): Message | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") {
        return msg;
      }
    }
    return undefined;
  }

  appendToAssistantMessage(token: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      last.content += token;
    } else {
      this.messages.push({
        role: "assistant",
        content: token,
        timestamp: new Date().toISOString(),
      });
    }
  }

  finalizeAssistantMessage(usage: TokenUsage): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant" && typeof last.content === "string") {
      (last as AssistantMessage).usage = usage;
    }
    this.metadata.updatedAt = new Date().toISOString();
  }

  buildMessages(tokenBudget?: number): Message[] {
    const systemContent = this.systemPrompt.assemble(
      tokenBudget ?? Infinity
    );
    const messages: Message[] = [];
    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }
    messages.push(...this.messages);
    return messages;
  }

  /**
   * 裁剪历史消息到指定 token 预算。
   * 从最新的 user/assistant 消息对开始保留，直到预算耗尽。
   * 处于中间的孤立 user 消息（无对应 assistant）会被丢弃。
   */
  trimToBudget(maxTokens: number): void {
    let tokens = this.tokenCounter.estimate(
      this.systemPrompt.assemble(Infinity)
    );

    const keep: Message[] = [];
    const pairs: { user: Message; assistant?: Message }[] = [];
    let currentUser: Message | null = null;

    for (const msg of this.messages) {
      if (msg.role === "user") {
        currentUser = msg;
      } else if (msg.role === "assistant" && currentUser) {
        pairs.push({ user: currentUser, assistant: msg });
        currentUser = null;
      }
    }

    for (let i = pairs.length - 1; i >= 0; i--) {
      const pair = pairs[i];
      const pairTokens =
        this.tokenCounter.estimateMessages([pair.user]) +
        (pair.assistant
          ? this.tokenCounter.estimateMessages([pair.assistant])
          : 0);

      if (tokens + pairTokens <= maxTokens) {
        keep.unshift(pair.user);
        if (pair.assistant) keep.unshift(pair.assistant);
        tokens += pairTokens;
      } else {
        break;
      }
    }

    // Put back in correct order
    const result: Message[] = [];
    for (const pair of pairs) {
      if (keep.includes(pair.user)) {
        result.push(pair.user);
        if (pair.assistant && keep.includes(pair.assistant)) {
          result.push(pair.assistant);
        }
      }
    }
    this.messages = result;
  }

  async save(filePath?: string): Promise<void> {
    const dir = path.dirname(
      filePath ?? path.join(DEFAULT_SESSIONS_DIR, `${this.id}.json`)
    );
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const targetPath =
      filePath ?? path.join(DEFAULT_SESSIONS_DIR, `${this.id}.json`);

    const sessionFile: SessionFile = {
      id: this.id,
      createdAt: this.metadata.createdAt,
      updatedAt: this.metadata.updatedAt,
      model: this.metadata.model,
      totalTokens: this.getTokenCount(),
      messageCount: this.getMessageCount(),
      systemPromptLayers: this.systemPrompt
        .getLayers()
        .map((l) => l.name),
      messages: this.messages,
      metadata: this.metadata,
    };

    await fs.promises.writeFile(
      targetPath,
      JSON.stringify(sessionFile, null, 2),
      "utf-8"
    );
  }

  static async load(filePath: string): Promise<ConversationManager> {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const data: SessionFile = JSON.parse(content);

    const mgr = new ConversationManager({
      id: data.id,
      model: data.model,
    });
    mgr.messages = data.messages;
    mgr.metadata = data.metadata;
    return mgr;
  }

  static async listSessions(
    dirPath?: string
  ): Promise<
    {
      id: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      model: string;
      messageCount: number;
    }[]
  > {
    const dir = dirPath ?? DEFAULT_SESSIONS_DIR;
    if (!fs.existsSync(dir)) return [];

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"));

    const sessions: {
      id: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      model: string;
      messageCount: number;
    }[] = [];

    for (const file of files) {
      try {
        const content = await fs.promises.readFile(
          path.join(dir, file),
          "utf-8"
        );
        const data: SessionFile = JSON.parse(content);
        sessions.push({
          id: data.id,
          title: data.metadata?.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          model: data.model,
          messageCount: data.messageCount,
        });
      } catch {
        // Skip corrupted files
      }
    }

    sessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() -
        new Date(a.updatedAt).getTime()
    );
    return sessions;
  }

  getTokenCount(): number {
    return Math.round(
      this.tokenCounter.estimateMessages(this.messages) *
        this.tokenCounter.ratio
    );
  }

  /**
   * Raw (uncalibrated) token estimate of the message history, excluding the
   * system prompt. Used as the base for calibration against real usage.
   */
  getMessageTokenBase(): number {
    return this.tokenCounter.estimateMessages(this.messages);
  }

  /**
   * Feed a real input-token count (from the backend's usage) back into the
   * calibrator, alongside the base estimate it was predicted from. Subsequent
   * getTokenCount() calls reflect the learned ratio.
   */
  observeUsage(baseEstimate: number, realInputTokens: number): void {
    this.tokenCounter.observe(baseEstimate, realInputTokens);
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  getMessages(): ReadonlyArray<Message> {
    return this.messages;
  }

  replaceMessages(messages: Message[]): void {
    this.messages = [...messages];
    this.metadata.updatedAt = new Date().toISOString();
  }

  /** Phase 3: clear all messages (for /clear command) */
  clear(): void {
    this.messages = [];
    this.metadata.updatedAt = new Date().toISOString();
  }

  /** Phase 3: return session summary (for /context command) */
  getStats(): {
    tokenCount: number;
    messageCount: number;
    model: string;
    sessionId: string;
  } {
    return {
      tokenCount: this.getTokenCount(),
      messageCount: this.getMessageCount(),
      model: this.metadata.model,
      sessionId: this.id,
    };
  }
}
