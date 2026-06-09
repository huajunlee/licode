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
