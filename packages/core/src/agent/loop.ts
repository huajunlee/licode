import * as path from "node:path";
import type { LLMProvider, Message } from "../llm/provider.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { Skill } from "../extensions/skills/loader.js";
import { polishAnswer, shouldPolish } from "./polish.js";
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
  /** Max tokens for the rolling summary. Default 2048. (Phase 5) */
  summaryMaxTokens?: number;
  /** Soft budget fraction (0-1) for should-keep turns. Optional. (Phase 5) */
  importantTurnsBudget?: number;
  /** Phase 5 toggles (default all true). */
  rollingSummary?: boolean;
  selectiveRetention?: boolean;
  fileChangeCompaction?: boolean;
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
   * 已加载的技能。loop 用它判断本次会话哪些技能被读过，
   * 以便在交付前对声明了 polishWith 的技能执行强制改写。
   */
  skills?: Skill[];
}

export class AgentLoop {
  private llm: LLMProvider;
  private conversation: ConversationManager;
  private tools: ToolRegistry;
  private executor: ToolExecutor;
  private termination: TerminationPolicy;
  private eventBus?: EventBus;
  private tokenCounter = new TokenCounter();
  // `importantTurnsBudget` is intentionally kept out of `Required` so it can
  // stay optional (read lazily from config where needed); everything else is
  // defaulted and thus non-optional on this instance.
  private context: Required<Omit<ContextConfig, "importantTurnsBudget">> & {
    importantTurnsBudget?: number;
  };
  private compressor?: ContextCompressor;
  private skills: Skill[];

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.conversation = config.conversation;
    this.tools = config.tools;
    this.skills = config.skills ?? [];
    this.context = {
      outputReserve: config.context?.outputReserve ?? 8192,
      compressThreshold: config.context?.compressThreshold ?? 0.85,
      keepRecentTurns: config.context?.keepRecentTurns ?? 2,
      summarizerModel: config.context?.summarizerModel ?? "deepseek-chat",
      overflowMaxBytes: config.context?.overflowMaxBytes ?? 64 * 1024,
      summaryMaxTokens: config.context?.summaryMaxTokens ?? 2048,
      rollingSummary: config.context?.rollingSummary ?? true,
      selectiveRetention: config.context?.selectiveRetention ?? true,
      fileChangeCompaction: config.context?.fileChangeCompaction ?? true,
      // importantTurnsBudget intentionally omitted: stays optional, read lazily.
    };
    this.executor = new ToolExecutor(config.tools, {
      overflowMaxBytes: this.context.overflowMaxBytes,
    });
    this.termination = new TerminationPolicy(config.termination ?? {});
    this.eventBus = config.eventBus;
    this.compressor = config.compressor;
  }

  /**
   * 交付前的强制改写。
   *
   * 只看一件事：本次会话有没有读过某个声明了 `polishWith` 的技能
   * （判据是 Read 过它目录下的 SKILL.md）。读过就按它指定的技能改写最终回答。
   *
   * 这是 harness 层的保证——技能正文里写"请记得改写"是可以被跳过的，
   * 而这里插在交付路径上，模型没有机会绕过。
   *
   * 任何一步出问题都保留原稿：宁可交付没润色的答案，也不能交付空答案或报错。
   */
  private async applyPolish(messages: readonly Message[], draft: string): Promise<string> {
    if (process.env.LICODE_POLISH === "off") return draft;

    const engaged = this.skills.filter((s) => s.polishWith && this.wasRead(messages, s));
    const target = engaged[0];
    if (!target) return draft;

    const polisher = this.skills.find((s) => s.name === target.polishWith);
    if (!polisher) return draft;
    // 规则正文挂在 target.polishBody 上（loadAll 回填），借用过来
    const prepared: Skill = { ...polisher, polishBody: target.polishBody };
    if (!shouldPolish(prepared, draft)) return draft;

    try {
      const polished = await polishAnswer({
        skill: prepared,
        llm: this.llm,
        model: this.conversation.metadata.model,
        draft,
      });
      // 落盘与事件都必须用改写后的文本，否则用户看到的和存下来的不是同一份
      this.conversation.replaceLastAssistantMessage(polished);
      this.eventBus?.emit({
        type: "skill-polish-applied",
        skill: target.name,
        via: target.polishWith!,
      });
      return polished;
    } catch {
      return draft;
    }
  }

  /** 判断某个技能的 SKILL.md 是否在本次会话里被 Read 过 */
  private wasRead(messages: readonly Message[], skill: Skill): boolean {
    const marker = path.join(skill.dir, "SKILL.md");
    return messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) =>
            b.name === "Read" &&
            typeof (b.input as { file_path?: unknown })?.file_path === "string" &&
            path.resolve((b.input as { file_path: string }).file_path) === path.resolve(marker)
        )
    );
  }

  async run(userInput: string): Promise<PipelineEvent> {
    this.conversation.addUserMessage(userInput);
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
            budgetTokens: Math.round(
              this.context.compressThreshold * this.llm.maxContextTokens
            ),
          });
          if (result.compressed) {
            this.eventBus?.emit({
              type: "context-compressed",
              method: result.method ?? "summarize",
              removedMessages: result.removedMessages,
              retainedTurns: result.retainedTurns,
              compactedTurns: result.compactedTurns,
              summaryUpdated: result.summaryUpdated,
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
          this.conversation.finalizeAssistantMessage(response.usage, response.thinking);

          // 交付前改写：本次会话读过、且声明了 polishWith 的技能，在此强制生效。
          // 放在 emit 之前——事件里的 message 与存盘的消息都必须是改写后的文本，
          // 否则用户看到的和落盘的不是同一份。
          const finalText = await this.applyPolish(this.conversation.getMessages(), response.content);

          this.eventBus?.emit({
            type: "agent-loop-complete",
            message: finalText,
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

        // 同一次响应的文本与 tool_use 必须落在同一条 assistant 消息里，
        // 否则 thinking 模式端点会整轮 400（见 provider.ts 的 ToolUseMessage.text）
        const inlineText = this.conversation.takeTrailingAssistantText();
        this.conversation.addToolMessages(
          response.toolUses,
          results,
          response.thinking,
          inlineText
        );
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
