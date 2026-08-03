import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time.js";

const NOW = new Date("2026-07-27T12:00:00");

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("relativeTime", () => {
  it("just now under 60 seconds", () => {
    expect(relativeTime(ago(0), NOW)).toBe("刚刚");
    expect(relativeTime(ago(59_000), NOW)).toBe("刚刚");
  });

  it("minutes under 60 minutes", () => {
    expect(relativeTime(ago(60_000), NOW)).toBe("1 分钟前");
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe("59 分钟前");
  });

  it("hours under 24 hours", () => {
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1 小时前");
    expect(relativeTime(ago(23 * 60 * 60_000), NOW)).toBe("23 小时前");
  });

  it("days under 30 days", () => {
    expect(relativeTime(ago(24 * 60 * 60_000), NOW)).toBe("1 天前");
    expect(relativeTime(ago(29 * 24 * 60 * 60_000), NOW)).toBe("29 天前");
  });

  it("absolute date at 30+ days", () => {
    expect(relativeTime("2026-06-20T08:00:00", NOW)).toBe("2026/6/20");
  });

  it("clamps future dates to 刚刚", () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("刚刚");
  });
});
