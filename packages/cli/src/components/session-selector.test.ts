import { describe, it, expect } from "vitest";
import { createCursor, moveCursor, visibleWindow, getVisiblePage } from "./session-selector.js";

interface SessionInfo {
  id: string;
}

const sessions: SessionInfo[] = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
];

function makeSessions(n: number): SessionInfo[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(i) }));
}

describe("session selector logic", () => {
  describe("createCursor", () => {
    it("returns 0 when sessions array is non-empty", () => {
      expect(createCursor(sessions)).toBe(0);
    });

    it("returns -1 when sessions array is empty", () => {
      expect(createCursor([])).toBe(-1);
    });
  });

  describe("moveCursor", () => {
    it("moveDown increments within bounds", () => {
      expect(moveCursor(0, "down", 3)).toBe(1);
      expect(moveCursor(1, "down", 3)).toBe(2);
      expect(moveCursor(2, "down", 3)).toBe(2); // clamped
    });

    it("moveUp decrements within bounds", () => {
      expect(moveCursor(2, "up", 3)).toBe(1);
      expect(moveCursor(1, "up", 3)).toBe(0);
      expect(moveCursor(0, "up", 3)).toBe(0); // clamped
    });

    it("returns -1 for empty list", () => {
      expect(moveCursor(-1, "down", 0)).toBe(-1);
      expect(moveCursor(-1, "up", 0)).toBe(-1);
    });

    it("clamps at 0 for single-session list", () => {
      expect(moveCursor(0, "down", 1)).toBe(0);
      expect(moveCursor(0, "up", 1)).toBe(0);
    });
  });

  describe("visibleWindow", () => {
    it("window starts at 0 when cursor is at the top", () => {
      expect(visibleWindow(0, 100, 10)).toBe(0);
    });

    it("window stays at 0 while cursor is within first page", () => {
      expect(visibleWindow(4, 100, 10)).toBe(0);
      expect(visibleWindow(9, 100, 10)).toBe(0);
    });

    it("window scrolls down when cursor reaches page boundary", () => {
      expect(visibleWindow(10, 100, 10)).toBe(1);
      expect(visibleWindow(15, 100, 10)).toBe(6);
      expect(visibleWindow(99, 100, 10)).toBe(90);
    });

    it("window scrolls up when cursor moves above current window", () => {
      // cursor at 5, window should show from 0
      expect(visibleWindow(5, 100, 10)).toBe(0);
    });

    it("window never exceeds max start index", () => {
      // cursor=50, total=55: window = min(50-9, 55-10) = min(41, 45) = 41
      expect(visibleWindow(50, 55, 10)).toBe(41);
      // cursor=99, total=100 (items 0-99): window = min(99-9, 100-10) = min(90, 90) = 90
      expect(visibleWindow(99, 100, 10)).toBe(90);
    });

    it("window returns 0 when total items <= pageSize", () => {
      expect(visibleWindow(0, 5, 10)).toBe(0);
      expect(visibleWindow(4, 5, 10)).toBe(0);
    });

    it("window returns 0 with empty list", () => {
      expect(visibleWindow(-1, 0, 10)).toBe(0);
    });
  });

  describe("getVisiblePage", () => {
    it("returns full list when total <= pageSize", () => {
      const items = makeSessions(5);
      const page = getVisiblePage(items, 0, 10);
      expect(page).toHaveLength(5);
      expect(page[0].item.id).toBe("0");
    });

    it("returns pageSize items anchored at windowStart", () => {
      const items = makeSessions(100);
      const page = getVisiblePage(items, 15, 10);
      expect(page).toHaveLength(10);
      expect(page[0].item.id).toBe("15");
      expect(page[9].item.id).toBe("24");
    });

    it("returns fewer items if window reaches end", () => {
      const items = makeSessions(55);
      const page = getVisiblePage(items, 50, 10);
      expect(page).toHaveLength(5);
    });

    it("marks the cursor item with isCursor=true", () => {
      const items = makeSessions(20);
      const page = getVisiblePage(items, 5, 10, 10); // cursor at item 10
      expect(page[0].isCursor).toBe(false);
      expect(page[5].isCursor).toBe(true); // index 5 in window = item 10 in full list
    });

    it("isCursor is false for all when cursorIndex is -1", () => {
      const items = makeSessions(5);
      const page = getVisiblePage(items, 0, 10, -1);
      expect(page.every((v) => !v.isCursor)).toBe(true);
    });
  });
});
