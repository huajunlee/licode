import { describe, it, expect } from "vitest";
import { cleanName, hhmmFromISO } from "./types.js";

describe("cleanName", () => {
  it("保留中文与字母数字，标点空格转 -", () => {
    expect(cleanName("开会，聊项目！")).toBe("开会-聊项目");
    expect(cleanName("Food, Drink!")).toBe("Food-Drink");
    expect(cleanName("a/b:c")).toBe("a-b-c");
  });
  it("去掉首尾与重复连字符", () => {
    expect(cleanName("－－标题－－")).toBe("标题");
    expect(cleanName("  标题  ")).toBe("标题");
  });
  it("空或全标点返回空", () => {
    expect(cleanName("")).toBe("");
    expect(cleanName("！！！")).toBe("");
  });
});

describe("hhmmFromISO", () => {
  it("取本地时区时分，与 new Date 一致", () => {
    const iso = "2026-08-01T06:30:00.000Z";
    const d = new Date(iso);
    const expected = String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
    expect(hhmmFromISO(iso)).toBe(expected);
  });
  it("返回 4 位数字", () => {
    expect(hhmmFromISO("2026-08-01T06:30:00.000Z")).toMatch(/^\d{4}$/);
  });
});
