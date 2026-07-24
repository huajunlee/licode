import { describe, it, expect } from "vitest";
import {
  createCursor,
  moveCursor,
  visibleWindow,
  getVisiblePage,
  hasNewSessionItem,
  isNewSessionIndex,
  sessionItemCount,
  resolveSelectedId,
} from "./session-selector.js";

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

  describe("新建会话 virtual item", () => {
    describe("hasNewSessionItem", () => {
      it("returns true when includeCreateNew is true", () => {
        expect(hasNewSessionItem(true)).toBe(true);
      });

      it("returns false when includeCreateNew is false", () => {
        expect(hasNewSessionItem(false)).toBe(false);
      });

      it("returns false when includeCreateNew is undefined", () => {
        expect(hasNewSessionItem(undefined)).toBe(false);
      });
    });

    describe("isNewSessionIndex", () => {
      it("returns true for index 0 when includeCreateNew is true", () => {
        expect(isNewSessionIndex(0, true)).toBe(true);
      });

      it("returns false for index 1 when includeCreateNew is true", () => {
        expect(isNewSessionIndex(1, true)).toBe(false);
      });

      it("returns false for any index when includeCreateNew is false", () => {
        expect(isNewSessionIndex(0, false)).toBe(false);
        expect(isNewSessionIndex(1, false)).toBe(false);
      });

      it("returns false for index -1", () => {
        expect(isNewSessionIndex(-1, true)).toBe(false);
      });
    });

    describe("sessionItemCount", () => {
      it("returns sessions.length + 1 when includeCreateNew is true", () => {
        expect(sessionItemCount(5, true)).toBe(6);
        expect(sessionItemCount(0, true)).toBe(1);
      });

      it("returns sessions.length when includeCreateNew is false", () => {
        expect(sessionItemCount(5, false)).toBe(5);
        expect(sessionItemCount(0, false)).toBe(0);
      });
    });

    describe("resolveSelectedId", () => {
      it("returns null when cursor is at new-session index 0", () => {
        const sessions = [{ id: "a" }, { id: "b" }];
        expect(resolveSelectedId(0, sessions, true)).toBeNull();
      });

      it("returns sessions[cursor - 1].id when cursor > 0", () => {
        const sessions = [{ id: "a" }, { id: "b" }];
        expect(resolveSelectedId(1, sessions, true)).toBe("a");
        expect(resolveSelectedId(2, sessions, true)).toBe("b");
      });

      it("returns null when cursor is out of bounds", () => {
        const sessions = [{ id: "a" }];
        expect(resolveSelectedId(-1, sessions, true)).toBeNull();
        expect(resolveSelectedId(5, sessions, true)).toBeNull();
      });

      it("works without includeCreateNew (backward compatible)", () => {
        const sessions = [{ id: "a" }, { id: "b" }];
        expect(resolveSelectedId(0, sessions, false)).toBe("a");
        expect(resolveSelectedId(1, sessions, false)).toBe("b");
      });
    });

    describe("moveCursor with new-session item", () => {
      it("clamps at 0 when moving up from new-session index", () => {
        // itemCount = 3 (1 new-session + 2 real sessions)
        expect(moveCursor(0, "up", 3)).toBe(0);
      });

      it("moves down from new-session to first real session", () => {
        expect(moveCursor(0, "down", 3)).toBe(1);
      });

      it("can move to last index which equals sessions.length (the new-session adds 1)", () => {
        // 3 items total (new-session + 2 sessions): indices 0, 1, 2
        expect(moveCursor(2, "down", 3)).toBe(2); // clamped at bottom
      });
    });

    describe("visibleWindow with new-session item", () => {
      it("includes new-session row at index 0 in first window", () => {
        // 20 real sessions + 1 virtual = 21 items, page size 15
        // cursor at 0 should show window at 0
        expect(visibleWindow(0, 21, 15)).toBe(0);
      });

      it("scrolls window when cursor passes page boundary with extra item", () => {
        // 21 items, page size 15, cursor at 15
        // expected: cursor 15 past window that starts at 0, window should start at 1
        // visibleWindow(15, 21, 15) = max(0, min(15-14, 6)) = max(0, 1) = 1
        expect(visibleWindow(15, 21, 15)).toBe(1);
      });
    });

    describe("getVisiblePage with new-session item", () => {
      it("first item in page can be the new-session virtual item", () => {
        const sessions = makeSessions(5);
        const page = getVisiblePage(sessions, 0, 10, 0);
        expect(page).toHaveLength(5);
      });
    });
  });

  describe("useSessionSelector simulation (includeCreateNew)", () => {
    const sessions = makeSessions(3);
    const PAGE_SIZE = 15;

    function simulate(options: { includeCreateNew?: boolean } = {}) {
      const inc = options.includeCreateNew ?? false;
      const itemCount = sessionItemCount(sessions.length, inc);
      let cursor = createCursor(sessions);

      return {
        state() {
          return {
            cursor,
            selectedId: resolveSelectedId(cursor, sessions, inc),
            isOnNewSession: isNewSessionIndex(cursor, inc),
            wStart: visibleWindow(cursor, itemCount, PAGE_SIZE),
          };
        },
        up() { cursor = moveCursor(cursor, "up", itemCount); },
        down() { cursor = moveCursor(cursor, "down", itemCount); },
      };
    }

    it("includeCreateNew: cursor 起始为 0，selectedId 为 null", () => {
      const s = simulate({ includeCreateNew: true }).state();
      expect(s.cursor).toBe(0);
      expect(s.selectedId).toBeNull();
      expect(s.isOnNewSession).toBe(true);
    });

    it("includeCreateNew: ↓ 从新建 → 第一个真实会话", () => {
      const sel = simulate({ includeCreateNew: true });
      sel.down();
      expect(sel.state().cursor).toBe(1);
      expect(sel.state().selectedId).toBe("0"); // sessions[1-1].id
      expect(sel.state().isOnNewSession).toBe(false);
    });

    it("includeCreateNew: ↑ 从 index 0 不动", () => {
      const sel = simulate({ includeCreateNew: true });
      sel.up();
      expect(sel.state().cursor).toBe(0);
      expect(sel.state().selectedId).toBeNull();
    });

    it("includeCreateNew: 能走到最后一个会话", () => {
      const sel = simulate({ includeCreateNew: true });
      sel.down(); sel.down(); sel.down(); // 0→1→2→3
      expect(sel.state().cursor).toBe(3);
      expect(sel.state().selectedId).toBe("2"); // sessions[2].id
      sel.down(); // clamped
      expect(sel.state().cursor).toBe(3);
    });

    it("无 includeCreateNew: 光标起始为 0，selectedId 为第一个会话", () => {
      const s = simulate({ includeCreateNew: false }).state();
      expect(s.cursor).toBe(0);
      expect(s.selectedId).toBe("0");
      expect(s.isOnNewSession).toBe(false);
    });

    it("includeCreateNew 时 getVisiblePage 的 cursor 需要 -1 偏移", () => {
      // 光标在新建会话(index 0)时，getVisiblePage 不应高亮任何 session
      const sessions = makeSessions(3); // sessions = [{id:"0"},{id:"1"},{id:"2"}]
      const inc = true;
      const cursor = 0; // 新建会话
      const sessionCursor = inc ? cursor - 1 : cursor; // -1

      const page = getVisiblePage(sessions, 0, 10, sessionCursor);
      // 所有 isCursor 应为 false
      expect(page.every((v) => !v.isCursor)).toBe(true);
    });

    it("includeCreateNew 时 getVisiblePage cursor 指向第一个真实会话", () => {
      const sessions = makeSessions(3);
      const inc = true;
      const cursor = 1; // 第一个真实会话
      const sessionCursor = inc ? cursor - 1 : cursor; // 0

      const page = getVisiblePage(sessions, 0, 10, sessionCursor);
      expect(page[0].isCursor).toBe(true); // sessions[0] highlighted
      expect(page[1].isCursor).toBe(false);
    });
  });
});
