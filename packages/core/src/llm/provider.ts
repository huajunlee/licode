export type Message = SystemMessage | UserMessage | AssistantMessage;

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
  usage?: TokenUsage;
  timestamp: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export type StreamChunk =
  | { type: "token"; text: string; index: number }
  | { type: "thinking"; text: string }
  | { type: "stop"; stopReason: string; usage: TokenUsage }
  | { type: "error"; error: Error };

export interface ChatRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  temperature?: number;
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
