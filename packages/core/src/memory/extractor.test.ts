import { describe, expect, it } from "vitest";
import { MemoryExtractor } from "./extractor.js";

describe("MemoryExtractor (new Memory type)", () => {
  const extractor = new MemoryExtractor();

  it("extracts explicit preference statements as Memory with type 'user'", () => {
    const entries = extractor.extract(
      "Remember that I prefer pnpm for this project."
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Preference",
        description: expect.stringContaining("prefer pnpm"),
      })
    );
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("extracts name from 'my name is' pattern → slug user/identity", () => {
    const entries = extractor.extract("My name is John Smith.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "User Name",
        description: "The user's name is John Smith.",
      })
    );
  });

  it("extracts name from Chinese '我叫' pattern → slug user/identity", () => {
    const entries = extractor.extract("我叫小明。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "User Name",
        description: "The user's name is 小明.",
      })
    );
  });

  it("extracts 'call me' pattern → slug user/identity", () => {
    const entries = extractor.extract("Call me Xiao Ming please.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "Preferred Name",
        description: "The user prefers to be called Xiao Ming please.",
      })
    );
  });

  it("extracts identity from 'I am a' pattern → slug user/identity", () => {
    const entries = extractor.extract("I am a software developer.");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        slug: "user/identity",
        type: "user",
        name: "User Identity",
        description: "The user is a software developer.",
      })
    );
  });

  it("extracts Chinese '记住我喜欢' as user type Memory", () => {
    const entries = extractor.extract("记住我喜欢用pnpm管理项目。");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Preference",
        description: "The user likes 用pnpm管理项目.",
      })
    );
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("extracts general 'remember that' as catch-all user Memory", () => {
    const entries = extractor.extract(
      "Remember that the database password is xyz123."
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Memory",
        description: "the database password is xyz123",
      })
    );
    expect(entries[0].slug).toMatch(/^user\//);
  });

  it("extracts Chinese general '记住' as catch-all user Memory", () => {
    const entries = extractor.extract("记住数据库密码是xyz123");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        type: "user",
        name: "Memory",
        description: "数据库密码是xyz123",
      })
    );
  });

  it("prefers specific patterns over general catch-all", () => {
    const entries = extractor.extract("记住我的名字是李四");
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("user/identity");
    expect(entries[0].name).toBe("User Name");
  });

  it("returns empty for non-memory text", () => {
    const entries = extractor.extract("What is the weather today?");
    expect(entries).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    const entries = extractor.extract("");
    expect(entries).toHaveLength(0);
  });

  it("has createdAt and updatedAt timestamps", () => {
    const entries = extractor.extract("My name is John Smith.");
    expect(entries[0].createdAt).toBeDefined();
    expect(entries[0].updatedAt).toBeDefined();
  });
});
