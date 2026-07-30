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
  /**
   * Raw (uncalibrated) token estimate of the tool definitions, fed in by the
   * AgentLoop each turn. Counted into getMessageTokenBase() so the calibrated
   * getTokenCount() reflects the full request (system + tools + messages),
   * not messages alone. (Phase 2 calibration upgrade.)
   */
  private toolTokenBase = 0;
  /** Context window + output reserve, fed in by the AgentLoop for /context. */
  private contextWindow = 0;
  private outputReserve = 0;

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
      this.getMessageTokenBase() * this.tokenCounter.ratio
    );
  }

  /**
   * Raw (uncalibrated) token estimate of the full request input: messages +
   * system prompt + tool definitions. Used as the base for calibration
   * against real usage. (Phase 2 upgrade: system + tools are now explicit so
   * the learned ratio only corrects estimation error instead of absorbing
   * whole missing components - eliminating the clamp-4 underestimate.)
   */
  getMessageTokenBase(): number {
    const systemTokens = this.tokenCounter.estimate(
      this.systemPrompt.assemble(Infinity)
    );
    return (
      this.tokenCounter.estimateMessages(this.messages) +
      systemTokens +
      this.toolTokenBase
    );
  }

  /**
   * Feed a real input-token count (from the backend's usage) back into the
   * calibrator, alongside the base estimate it was predicted from. Subsequent
   * getTokenCount() calls reflect the learned ratio.
   */
  observeUsage(baseEstimate: number, realInputTokens: number): void {
    this.tokenCounter.observe(baseEstimate, realInputTokens);
  }

  /**
   * Set the raw token estimate of the tool definitions, so getMessageTokenBase
   * and getTokenCount include tool overhead. Called by AgentLoop each turn
   * (tools don't change within a session, but re-setting is cheap and safe).
   * (Phase 2 calibration upgrade.)
   */
  setToolTokenBase(tokens: number): void {
    this.toolTokenBase = tokens;
  }

  /**
   * Set the context window and output reserve, fed in by the AgentLoop each
   * turn so /context can display budget info. (Phase 2.)
   */
  setContextBudget(budget: {
    contextWindow: number;
    outputReserve: number;
  }): void {
    this.contextWindow = budget.contextWindow;
    this.outputReserve = budget.outputReserve;
  }

  /** Budget snapshot for the /context command. (Phase 2.) */
  getBudgetInfo(): {
    contextWindow: number;
    outputReserve: number;
    used: number;
    remaining: number;
  } {
    const used = this.getTokenCount();
    return {
      contextWindow: this.contextWindow,
      outputReserve: this.outputReserve,
      used,
      remaining: Math.max(0, this.contextWindow - used),
    };
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
