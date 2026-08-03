import { COLORS, ICONS } from "../theme.js";
import { truncateToWidth } from "./session-row.js";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallState {
  toolName: string;
  status: ToolCallStatus;
  detail?: string;
  result?: string;
}

export interface ToolLine {
  icon: string;
  color: string;
  name: string;
  /** Truncated to 40 columns; "" when absent */
  detail: string;
  /** Only for done - truncated to 40 columns; "" otherwise */
  summary: string;
}

/** done 态需完整展开 result 的工具（计划/评估是多行 artifact，不能截断 40 列）。 */
export const FULL_EXPAND_TOOLS = new Set(["decide_plan", "decide_reflect"]);

/** 是否对当前工具的 done 结果做完整展开。纯函数，便于测试。 */
export function shouldExpandFull(
  toolName: string,
  status: ToolCallStatus,
  result?: string
): boolean {
  return status === "done" && FULL_EXPAND_TOOLS.has(toolName) && Boolean(result);
}

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: ICONS.toolPending,
  running: ICONS.toolRunning,
  done: ICONS.toolDone,
  error: ICONS.toolError,
};

const STATUS_COLORS: Record<ToolCallStatus, string> = {
  pending: COLORS.muted,
  running: COLORS.accent,
  done: COLORS.success,
  error: COLORS.error,
};

export function formatToolLine(call: ToolCallState): ToolLine {
  return {
    icon: STATUS_ICONS[call.status],
    color: STATUS_COLORS[call.status],
    name: call.toolName,
    detail: call.detail ? truncateToWidth(call.detail, 40) : "",
    summary:
      call.status === "done" && call.result
        ? truncateToWidth(call.result, 40)
        : "",
  };
}

/** Char-based truncate kept for error expansion (200 chars). */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
