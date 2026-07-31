import type { LLMProvider } from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../tools/executor.js";
import {
  TerminationPolicy,
  TerminationError,
} from "./termination.js";
import type { TerminationConfig } from "./termination.js";
import { collectResponse } from "./react.js";
import type { EventBus } from "./react.js";
import { TokenCounter } from "../llm/token-counter.js";
import type { ContextCompressor } from "../context/compressor.js";
import type { PipelineEvent, Middleware } from "../events/types.js";

export type { EventBus } from "./react.js";

/**
 * Phase 2: context-management tuning. All optional with sensible defaults.
 */
export interface ContextConfig {
  /** Tokens reserved for the model's output. Default 8192. */
  outputReserve?: number;
  /** Fraction of the context window at which compression triggers. Default 0.85. */
  compressThreshold?: number;
  /** Number of recent complete turns to keep intact when compressing. Default 2. */
  keepRecentTurns?: number;
  /** Model used for the summarization side-call. Default "deepseek-chat". */
  summarizerModel?: string;
  /** Max inline bytes for a tool's success output; larger spills to .licode/overflow/. Default 64KB. (Phase 4) */
  overflowMaxBytes?: number;
}

export interface AgentConfig {
  llm: LLMProvider;
  conversation: ConversationManager;
  tools: ToolRegistry;
  termination?: TerminationConfig;
  context?: ContextConfig;
  /**
   * Phase 2: structure-aware compressor. When present, the loop compresses
   * the conversation once per run when it crosses compressThreshold,
   * replacing the "hit maxTokens and die" behavior. If absent, the loop
   * falls back to the plain hard-stop gate.
   */
  compressor?: ContextCompressor;
  eventBus?: EventBus;
  /**
   * Optional per-turn hook: fires once in run() after the user message is
   * appended and before the first LLM call. Errors are swallowed - the
   * loop must never break because of it. (Phase 2 memory recall injects
   * here.)
   */
  onTurnStart?: (conversation: ConversationManager) => Promise<void>;
}

export class AgentLoop {
  private llm: LLMProvider;
  private conversation: ConversationManager;
  private tools: ToolRegistry;
  private executor: ToolExecutor;
  private termination: TerminationPolicy;
  private eventBus?: EventBus;
  private onTurnStart?: (conversation: ConversationManager) => Promise<void>;
  private tokenCounter = new TokenCounter();
  private context: Required<ContextConfig>;
  private compressor?: ContextCompressor;

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.conversation = config.conversation;
    this.tools = config.tools;
    this.context = {
      outputReserve: config.context?.outputReserve ?? 8192,
      compressThreshold: config.context?.compressThreshold ?? 0.85,
      keepRecentTurns: config.context?.keepRecentTurns ?? 2,
      summarizerModel: config.context?.summarizerModel ?? "deepseek-chat",
      overflowMaxBytes: config.context?.overflowMaxBytes ?? 64 * 1024,
    };
    this.executor = new ToolExecutor(config.tools, {
      overflowMaxBytes: this.context.overflowMaxBytes,
    });
    this.termination = new TerminationPolicy(config.termination ?? {});
    this.eventBus = config.eventBus;
    this.onTurnStart = config.onTurnStart;
    this.compressor = config.compressor;
  }

  async run(userInput: string): Promise<PipelineEvent> {
    this.conversation.addUserMessage(userInput);
    if (this.onTurnStart) {
      try {
        await this.onTurnStart(this.conversation);
      } catch {
        // best-effort hook - never break the loop
      }
    }
    this.eventBus?.emit({ type: "agent-loop-start" });

    // Phase 2: feed tool-definition tokens into the conversation base so the
    // calibrated getTokenCount() (used by the termination gate + status bar)
    // reflects the full request - system + tools + messages - not messages
    // alone. Tools don't change within a session; re-setting per run is cheap.
    this.conversation.setToolTokenBase(
      this.tokenCounter.estimate(JSON.stringify(this.tools.toLLMTools()))
    );
    // Also publish window/reserve so /context can show remaining budget.
    this.conversation.setContextBudget({
      contextWindow: this.llm.maxContextTokens,
      outputReserve: this.context.outputReserve,
    });

    let stepIndex = 0;
    // Compress at most once per run: summarize older turns when the context
    // crosses the threshold, then let the gate act as the post-compression
    // fallback. Guarding once avoids re-summarizing the SUMMARY mid-turn.
    let compressedThisRun = false;

    while (true) {
      try {
        if (
          !compressedThisRun &&
          this.compressor &&
          this.conversation.getTokenCount() >
            this.context.compressThreshold * this.llm.maxContextTokens
        ) {
          const result = await this.compressor.compress(this.conversation, {
            keepRecentTurns: this.context.keepRecentTurns,
          });
          if (result.compressed) {
            this.eventBus?.emit({
              type: "context-compressed",
              method: result.method ?? "summarize",
              removedMessages: result.removedMessages,
            });
          }
          compressedThisRun = true;
        }

        this.termination.check(this.conversation.getTokenCount());

        const toolDefs = this.tools.toLLMTools();
        // Phase 2: compute the real system-prompt budget (raw units, matching
        // SystemPrompt.assemble's internal TokenCounter). system prompt gets
        // whatever is left of the input window after output reserve, messages,
        // and tools. Under pressure assemble() drops/truncates optional layers;
        // always layers (role/safety) are always kept.
        const rawMessages = this.tokenCounter.estimateMessages([
          ...this.conversation.getMessages(),
        ]);
        const rawTools = this.tokenCounter.estimate(JSON.stringify(toolDefs));
        const systemBudget = Math.max(
          0,
          this.llm.maxContextTokens -
            this.context.outputReserve -
            rawMessages -
            rawTools
        );
        const messages = this.conversation.buildMessages(systemBudget);

        this.eventBus?.emit({
          type: "agent-loop-step",
          index: stepIndex,
          reasoning: "",
        });

        const requestBase = this.conversation.getMessageTokenBase();
        const response = await collectResponse(
          this.llm,
          messages,
          toolDefs,
          this.conversation,
          this.eventBus
        );

        // Calibrate the token estimator against the real input-token count
        // reported by the backend. requestBase was captured before the
        // assistant response was appended, so it matches the request input.
        this.conversation.observeUsage(requestBase, response.usage.input);

        if (response.type === "text") {
          if (!response.content) {
            this.conversation.appendToAssistantMessage("");
          }
          this.conversation.finalizeAssistantMessage(response.usage);
          this.eventBus?.emit({
            type: "agent-loop-complete",
            message: response.content,
            usage: response.usage,
          });
          await this.conversation.save();
          return {
            type: "stream-complete" as const,
            messages: [...this.conversation.getMessages()],
          };
        }

        // tool-use branch
        this.eventBus?.emit({
          type: "tool-use-detected",
          toolUses: response.toolUses,
        });

        for (const tu of response.toolUses) {
          this.eventBus?.emit({
            type: "tool-execute-start",
            toolName: tu.name,
            input: tu.input,
          });
        }

        const results = await this.executor.executeParallel(
          response.toolUses
        );

        for (let i = 0; i < response.toolUses.length; i++) {
          this.eventBus?.emit({
            type: "tool-execute-complete",
            toolName: response.toolUses[i].name,
            result: results[i],
          });
        }

        this.conversation.addToolMessages(response.toolUses, results);
        this.termination.incrementStep();
        stepIndex++;
        continue;
      } catch (err) {
        if (err instanceof TerminationError) {
          this.eventBus?.emit({
            type: "agent-loop-terminated",
            reason: err.message,
            stats: err.stats,
          });
          return {
            type: "stream-complete" as const,
            messages: [...this.conversation.getMessages()],
          };
        }
        throw err;
      }
    }
  }
}

export function createAgentLoopMiddleware(
  config: AgentConfig
): Middleware {
  return async (event, next) => {
    if (event.type !== "user-message") {
      return next();
    }

    const loop = new AgentLoop(config);
    await loop.run(event.content);
    await next();
  };
}
