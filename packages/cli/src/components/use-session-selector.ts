import { useState, useMemo, useCallback } from "react";
import {
  createCursor,
  moveCursor,
  visibleWindow,
  getVisiblePage,
} from "./session-selector.js";
import type { VisibleItem } from "./session-selector.js";

export type { VisibleItem };

const PAGE_SIZE = 15;

export interface SessionInfo {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
}

export function useSessionSelector(sessions: SessionInfo[]) {
  const [cursorIndex, setCursorIndex] = useState(() =>
    createCursor(sessions)
  );

  const moveDown = useCallback(() => {
    setCursorIndex((prev) => moveCursor(prev, "down", sessions.length));
  }, [sessions.length]);

  const moveUp = useCallback(() => {
    setCursorIndex((prev) => moveCursor(prev, "up", sessions.length));
  }, [sessions.length]);

  const selectedId =
    cursorIndex >= 0 && cursorIndex < sessions.length
      ? sessions[cursorIndex].id
      : null;

  const windowStart = useMemo(
    () => visibleWindow(cursorIndex, sessions.length, PAGE_SIZE),
    [cursorIndex, sessions.length]
  );

  const visibleItems: VisibleItem<SessionInfo>[] = useMemo(
    () =>
      getVisiblePage(sessions, windowStart, PAGE_SIZE, cursorIndex),
    [sessions, windowStart, cursorIndex]
  );

  return {
    cursorIndex,
    moveDown,
    moveUp,
    selectedId,
    windowStart,
    visibleItems,
  };
}
