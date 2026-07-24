import { describe, expect, it } from "vitest";
import { MemoryExtractor } from "./extractor.js";

describe("MemoryExtractor", () => {
  const extractor = new MemoryExtractor();

  it("extracts explicit preference statements from conversation text", () => {
    const entries = extractor.extract(
      "Remember that I prefer pnpm for this project."
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "Preference",
        content: expect.stringContaining("prefer pnpm"),
      })
    );
  });

  it("extracts name from 'my name is' pattern", () => {
    const entries = extractor.extract("My name is John Smith.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "User Name",
        content: "The user's name is John Smith.",
        tags: ["identity"],
      })
    );
  });

  it("extracts name from Chinese '我叫' pattern", () => {
    const entries = extractor.extract("我叫小明。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "User Name",
        content: "The user's name is 小明.",
        tags: ["identity"],
      })
    );
  });

  it("extracts name from Chinese '我的名字是' pattern", () => {
    const entries = extractor.extract("我的名字是张三");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "User Name",
        content: "The user's name is 张三.",
      })
    );
  });

  it("extracts 'call me' pattern", () => {
    const entries = extractor.extract("Call me Xiao Ming please.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "Preferred Name",
        content: "The user prefers to be called Xiao Ming please.",
      })
    );
  });

  it("extracts Chinese '请叫我' pattern", () => {
    const entries = extractor.extract("请叫我老王。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "Preferred Name",
        content: "The user prefers to be called 老王.",
      })
    );
  });

  it("extracts identity from 'I am a' pattern", () => {
    const entries = extractor.extract("I am a software developer.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "User Identity",
        content: "The user is a software developer.",
        tags: ["identity"],
      })
    );
  });

  it("extracts identity from Chinese '我是' pattern", () => {
    const entries = extractor.extract("我是一名前端工程师。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "User Identity",
        content: "The user is 前端工程师.",
        tags: ["identity"],
      })
    );
  });

  it("extracts Chinese preference pattern '记住我喜欢'", () => {
    const entries = extractor.extract("记住我喜欢用pnpm管理项目。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "Preference",
        content: "The user likes 用pnpm管理项目.",
        tags: ["preference"],
      })
    );
  });

  it("extracts general 'remember that' as catch-all", () => {
    const entries = extractor.extract(
      "Remember that the database password is xyz123."
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "Memory",
        content: "the database password is xyz123",
        tags: ["general"],
      })
    );
  });

  it("extracts Chinese general '记住' as catch-all", () => {
    const entries = extractor.extract("记住数据库密码是xyz123");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        title: "Memory",
        content: "数据库密码是xyz123",
        tags: ["general"],
      })
    );
  });

  it("prefers specific patterns over general catch-all", () => {
    const entries = extractor.extract("记住我的名字是李四");
    // Should match name pattern (specific) not general catch-all
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("User Name");
  });

  it("returns empty for non-memory text", () => {
    const entries = extractor.extract("What is the weather today?");
    expect(entries).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    const entries = extractor.extract("");
    expect(entries).toHaveLength(0);
  });
});
