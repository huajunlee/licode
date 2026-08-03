import { useState, useMemo, useCallback } from "react";
import {
  createCursor,
  moveCursor,
  visibleWindow,
  getVisiblePage,
  sessionItemCount,
  resolveSelectedId,
  isNewSessionIndex,
} from "./session-selector.js";
import type { VisibleItem } from "./session-selector.js";

export type { VisibleItem };

const PAGE_SIZE = 15;

export interface SessionInfo {
  id: string;
  title?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
}

export interface UseSessionSelectorOptions {
  /** When true, a virtual "+ 新建会话" item is added at index 0 */
  includeCreateNew?: boolean;
}

export function useSessionSelector(
  sessions: SessionInfo[],
  options: UseSessionSelectorOptions = {}
) {
  const { includeCreateNew = false } = options;
  const itemCount = sessionItemCount(sessions.length, includeCreateNew);

  const [cursorIndex, setCursorIndex] = useState(() =>
    createCursor(sessions)
  );

  const moveDown = useCallback(() => {
    setCursorIndex((prev) => moveCursor(prev, "down", itemCount));
  }, [itemCount]);

  const moveUp = useCallback(() => {
    setCursorIndex((prev) => moveCursor(prev, "up", itemCount));
  }, [itemCount]);

  const selectedId = useMemo(
    () => resolveSelectedId(cursorIndex, sessions, includeCreateNew),
    [cursorIndex, sessions, includeCreateNew]
  );

  const isOnNewSession = useMemo(
    () => isNewSessionIndex(cursorIndex, includeCreateNew),
    [cursorIndex, includeCreateNew]
  );

  const windowStart = useMemo(
    () => visibleWindow(cursorIndex, itemCount, PAGE_SIZE),
    [cursorIndex, itemCount]
  );

  const visibleItems: VisibleItem<SessionInfo>[] = useMemo(() => {
    // Map cursor from virtual space (0 = new session) to session space
    const sessionCursor = includeCreateNew ? cursorIndex - 1 : cursorIndex;
    return getVisiblePage(sessions, windowStart, PAGE_SIZE, sessionCursor);
  }, [sessions, windowStart, cursorIndex, includeCreateNew]);

  return {
    cursorIndex,
    moveDown,
    moveUp,
    selectedId,
    isOnNewSession,
    windowStart,
    visibleItems,
  };
}
