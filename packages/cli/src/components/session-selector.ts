export function createCursor<T>(items: T[]): number {
  return items.length > 0 ? 0 : -1;
}

export function moveCursor(
  current: number,
  direction: "up" | "down",
  itemCount: number
): number {
  if (itemCount === 0) return -1;
  if (direction === "down") {
    return Math.min(current + 1, itemCount - 1);
  }
  return Math.max(current - 1, 0);
}

/**
 * Compute the start index of the visible window so that cursorIndex
 * is always visible within a window of at most `pageSize` items.
 *
 * The window only moves when the cursor would exit it.
 */
export function visibleWindow(
  cursorIndex: number,
  totalItems: number,
  pageSize: number
): number {
  if (totalItems <= pageSize || totalItems === 0) return 0;
  const maxStart = totalItems - pageSize;
  // By default window starts just enough to include the cursor,
  // but never goes above cursor or below maxStart.
  return Math.max(0, Math.min(cursorIndex - pageSize + 1, maxStart));
}

export interface VisibleItem<T> {
  item: T;
  isCursor: boolean;
}

export function getVisiblePage<T>(
  items: T[],
  windowStart: number,
  pageSize: number,
  cursorIndex?: number
): VisibleItem<T>[] {
  const end = Math.min(windowStart + pageSize, items.length);
  const result: VisibleItem<T>[] = [];
  for (let i = windowStart; i < end; i++) {
    result.push({
      item: items[i],
      isCursor: cursorIndex !== undefined && i === cursorIndex,
    });
  }
  return result;
}

// ---- 新建会话 virtual item helpers ----

/** Whether the "+ 新建会话" item should appear */
export function hasNewSessionItem(includeCreateNew?: boolean): boolean {
  return includeCreateNew === true;
}

/** Is the cursor on the virtual "+ 新建会话" item (always at index 0)? */
export function isNewSessionIndex(
  index: number,
  includeCreateNew?: boolean
): boolean {
  return includeCreateNew === true && index === 0;
}

/** Total selectable items: sessions + 1 virtual item (if enabled) */
export function sessionItemCount(
  sessionCount: number,
  includeCreateNew?: boolean
): number {
  return includeCreateNew ? sessionCount + 1 : sessionCount;
}

/**
 * Map cursor index to a session ID.
 * When includeCreateNew is true, index 0 = "new session" → null.
 */
export function resolveSelectedId(
  cursorIndex: number,
  sessions: Array<{ id: string }>,
  includeCreateNew?: boolean
): string | null {
  if (includeCreateNew && cursorIndex === 0) return null;
  const offset = includeCreateNew ? 1 : 0;
  const sessionIndex = cursorIndex - offset;
  if (sessionIndex < 0 || sessionIndex >= sessions.length) return null;
  return sessions[sessionIndex].id;
}
