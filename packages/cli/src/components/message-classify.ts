import type { Message } from "@licode/core";

export type MessageKind =
  | "system"
  | "user"
  | "assistant-text"
  | "tool-use"
  | "tool-result";

export function classifyMessage(msg: Message): MessageKind {
  if (msg.role === "system") return "system";
  if (typeof msg.content === "string") {
    return msg.role === "user" ? "user" : "assistant-text";
  }
  return msg.role === "assistant" ? "tool-use" : "tool-result";
}

export function toolNames(msg: Message): string {
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((b) => ("name" in b ? String(b.name) : ""))
    .filter(Boolean)
    .join(", ");
}
