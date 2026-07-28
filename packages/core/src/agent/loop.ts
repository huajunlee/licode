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
import type { PipelineEvent, Middleware } from "../events/types.js";

export type { EventBus } from "./react.js";

export interface AgentConfig {
  llm: LLMProvider;
  conversation: ConversationManager;
  tools: ToolRegistry;
  termination?: TerminationConfig;
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

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.conversation = config.conversation;
    this.tools = config.tools;
    this.executor = new ToolExecutor(config.tools);
    this.termination = new TerminationPolicy(config.termination ?? {});
    this.eventBus = config.eventBus;
    this.onTurnStart = config.onTurnStart;
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

    let stepIndex = 0;

    while (true) {
      try {
        this.termination.check(this.conversation.getTokenCount());

        const messages = this.conversation.buildMessages();
        const toolDefs = this.tools.toLLMTools();

        this.eventBus?.emit({
          type: "agent-loop-step",
          index: stepIndex,
          reasoning: "",
        });

        const response = await collectResponse(
          this.llm,
          messages,
          toolDefs,
          this.conversation,
          this.eventBus
        );

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
