export { AnthropicProvider } from "./llm/anthropic.js";
export type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  TokenUsage,
  // Phase 2 types
  ToolUseMessage,
  ToolResultMessage,
  ToolUseBlock,
  ToolResultBlock,
  LLMToolDefinition,
} from "./llm/provider.js";
export { TokenCounter } from "./llm/token-counter.js";
export { collectStream, mergeChunks } from "./llm/stream.js";
export { ConversationManager } from "./conversation/manager.js";
export type { ConversationMetadata } from "./conversation/manager.js";
export { SystemPrompt, loadDefaultLayers } from "./conversation/system-prompt.js";
export type { SystemPromptLayer } from "./conversation/system-prompt.js";
export { EventPipeline } from "./events/pipeline.js";
export type { MiddlewareEntry } from "./events/pipeline.js";
export type { PipelineEvent, Middleware } from "./events/types.js";
export { generateChatEvents } from "./events/generator.js";
export { loggingMiddleware } from "./events/middleware/logging.js";
export { tokenCountingMiddleware } from "./events/middleware/token-count.js";
export { errorHandlerMiddleware } from "./events/middleware/error-handler.js";

// Phase 2: tools/
export { ToolRegistry } from "./tools/registry.js";
export { ToolExecutor } from "./tools/executor.js";
export type { Tool, ToolContext, ToolResult } from "./tools/types.js";
export {
  builtinTools,
  bashTool,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
} from "./tools/builtin/index.js";

// Phase 2: agent/
export { AgentLoop, createAgentLoopMiddleware } from "./agent/loop.js";
export type { AgentConfig, EventBus } from "./agent/loop.js";
export { TerminationPolicy, TerminationError } from "./agent/termination.js";
export type {
  TerminationConfig,
  TerminationStats,
} from "./agent/termination.js";
export { collectResponse } from "./agent/react.js";
export type { CollectResult } from "./agent/react.js";

// Phase 3: MCP
export { MCPClientManager, MCPServerConnection } from "./extensions/mcp/client.js";
export type { MCPServerConfig, ServerStatus, MCPConfig } from "./extensions/mcp/client.js";
export { StdioTransport } from "./extensions/mcp/transport.js";
export type { MCPTransport, JSONRPCMessage } from "./extensions/mcp/transport.js";
export { mcpToolToAdapter, jsonSchemaToZod } from "./extensions/mcp/adapter.js";
export { loadMCPConfig } from "./extensions/mcp/config.js";

// Phase 3: Skill
export { SkillLoader } from "./extensions/skills/loader.js";
export type { Skill, SkillToolDef } from "./extensions/skills/loader.js";
export { skillToolToAdapter, skillToPromptLayer } from "./extensions/skills/adapter.js";
export { parseYamlFrontmatter, skillParamsToZod } from "./extensions/skills/parser.js";

// Phase 3: Command
export { CommandRouter } from "./extensions/commands/router.js";
export type { SlashCommand, CommandContext, CommandResult } from "./extensions/commands/registry.js";
export { helpCommand, helpRecipesCommand, helpShortcutsCommand, helpToolsCommand } from "./extensions/commands/builtin/help.js";
export { clearCommand } from "./extensions/commands/builtin/clear.js";
export { contextCommand } from "./extensions/commands/builtin/context.js";
export { memoryCommand, memoryListCommand, memoryAddCommand, memoryDeleteCommand, memoryArchiveCommand, memoryRestoreCommand, memoryPinCommand, memoryUnpinCommand } from "./extensions/commands/builtin/memory.js";

// Phase 3: Hook
export { HookManager, hookMiddleware, resolvePosition } from "./extensions/hooks/manager.js";
export { emitAfterAgentLoop } from "./extensions/hooks/emit-event.js";
export type { HookConfig, HookPosition, RegisteredHook, HookFunction } from "./extensions/hooks/types.js";
export { initializeExtensions, registerExtensionMiddleware } from "./extensions/startup.js";
export type {
  InitializeExtensionsOptions,
  InitializedExtensions,
} from "./extensions/startup.js";

// Phase 4: safety/context/memory/session
export { PermissionGuard } from "./safety/permissions.js";
export { createSandbox } from "./safety/sandbox.js";
export type { Sandbox, SandboxCommand, SandboxOptions } from "./safety/sandbox.js";
export type {
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  PermissionUI,
  ToolPermissionGuard,
} from "./safety/types.js";
export { TokenBudget } from "./context/token-budget.js";
export { ContextCompressor } from "./context/compressor.js";
export { Summarizer, CompressionAssistant } from "./context/summarizer.js";
export { overflowToolResult } from "./context/overflow.js";
export type {
  TokenBudgetConfig,
  TokenBudgetUsage,
} from "./context/token-budget.js";
export type {
  ContextCompressorConfig,
  CompressionResult,
} from "./context/compressor.js";
// Phase 5: context-compression building blocks
export { getRecoveryPointer } from "./context/git-pointer.js";
export type { RecoveryPointer } from "./context/git-pointer.js";
export {
  computeStats,
  buildFileChangeMessage,
  isFileChangeMessage,
  parseFileChangeMessage,
  WRITE_TOOL_NAMES,
  EDIT_TOOL_NAMES,
} from "./context/file-change.js";
export type { FileChangeNote, FileChangeStats, FileChangeOperation } from "./context/file-change.js";
export { classifyMiddleTurns, extractExistingSummary, isSummaryMessage } from "./context/compressor.js";
export { MemoryStore } from "./memory/store.js";
export type { MemoryAction } from "./memory/store.js";
export { MemoryLoader } from "./memory/loader.js";
export { MemoryExtractor } from "./memory/extractor.js";               // Step 2: LLM-based
export { RegexMemoryExtractor } from "./memory/extractor-regex.js";    // @deprecated
export { memoryMiddleware } from "./memory/middleware.js";             // @deprecated
export { createMemoryExtractionHook, createMemoryExtractionState } from "./memory/hook.js"; // in-process hook
export type { MemoryExtractionHookFn, MemoryExtractionState } from "./memory/hook.js";
export { MemoryRecall, MEMORY_RECALL_TOOL_NAME, pruneRecallMessages, buildRecallPair, createMemoryRecallHandler } from "./memory/recall.js"; // Phase 2: side-query recall
export type { MemoryRecallConfig } from "./memory/recall.js";
export { MemoryDream, createMemoryDreamHook, createMemoryDreamState, acquireLock, releaseLock, readState, writeState } from "./memory/dream.js"; // Phase 3: dream consolidation
export type { DreamConfig, DreamState, Suspicion } from "./memory/dream.js";
export type { Memory, MemoryType, MemoryEntry } from "./memory/types.js";
export { toSlug } from "./memory/types.js";
export { SessionManager } from "./session/manager.js";
export type { SessionSummary } from "./session/manager.js";
export { recoverLatestSession } from "./session/recovery.js";

// Phase 5: multi-agent
export { createAgentTool } from "./multi-agent/agent-tool.js";
export { SubAgentManager } from "./multi-agent/subagent.js";
export type { SubAgentManagerConfig } from "./multi-agent/subagent.js";
export { WorktreeManager } from "./multi-agent/worktree.js";
export type { WorktreeManagerConfig } from "./multi-agent/worktree.js";
export { SubAgentSettings, subagentCommand } from "./multi-agent/commands.js";
export type {
  AgentRunner,
  AgentSummary,
  AgentToolInput,
  GitResult,
  WorktreeContext,
} from "./multi-agent/types.js";
