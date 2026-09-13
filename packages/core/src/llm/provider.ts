// --- Phase 2: tool-use blocks ---

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// --- Phase 2: tool messages (Anthropic Messages API conformant) ---

/**
 * Extended-thinking 内容块。
 *
 * Anthropic 的 thinking 模式要求：开了 thinking 的请求，助手消息里的 thinking 块
 * **必须原样回传**（含 signature）到下一轮，否则整个请求被拒：
 * `400 The content[].thinking in the thinking mode must be passed back to the API.`
 * 所以这里不能只把它当成展示用的中间产物。
 */
export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

export interface ToolUseMessage {
  role: "assistant";
  content: ToolUseBlock[];
  thinking?: ThinkingBlock[];
  /**
   * 同一次响应里 tool_use 之前的那段文本。
   *
   * 必须和 tool_use 存在**同一条**消息里：thinking 模式下把一次响应拆成
   * 「文本一条 + tool_use 一条」会被 API 整轮拒掉（实测 400
   * `The content[].thinking in the thinking mode must be passed back to the API.`）。
   */
  text?: string;
  timestamp: string;
}

export interface ToolResultMessage {
  role: "user";
  content: ToolResultBlock[];
  timestamp: string;
}

// --- Phase 2: LLM tool definition (JSON Schema format) ---

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// --- Message union ---

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
  timestamp: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  /** 见 ThinkingBlock：开了 thinking 时必须随消息回传。 */
  thinking?: ThinkingBlock[];
  usage?: TokenUsage;
  timestamp: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  /** 前缀缓存命中 token（Anthropic 格式 cache_read_input_tokens）。 */
  cacheRead?: number;
  /** 前缀缓存创建 token（Anthropic 格式 cache_creation_input_tokens）。 */
  cacheCreation?: number;
}

export type StreamChunk =
  | { type: "token"; text: string; index: number }
  /** 流式增量，只用于实时展示；存回历史请用 thinking-block。 */
  | { type: "thinking"; text: string }
  /** 一个完整的 thinking 块（文本 + signature），用于回传给下一轮请求。 */
  | { type: "thinking-block"; block: ThinkingBlock }
  | { type: "tool-use"; toolUse: ToolUseBlock }
  | { type: "stop"; stopReason: string; usage: TokenUsage }
  | { type: "error"; error: Error };

export interface ChatRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LLMToolDefinition[];
  // 透传 provider 特有参数（thinking, cache_control 等）。
  // Phase 1 不做类型化，后续 Phase 给具体类型。
  extensions?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  usage: TokenUsage;
  stopReason: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly maxContextTokens: number;

  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamChunk>;
  countTokens(messages: Message[]): number;
}
