import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const templatesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "templates"
);
const memoryGuidePath = path.join(templatesDir, "memory-guide.md");

describe("memory-guide.md write-dedup instruction", () => {
  const content = fs.readFileSync(memoryGuidePath, "utf-8");

  it("不再无条件要求'创建前先用 Read 查重'", () => {
    // 旧指令对新主题无合法目标，逼模型 Read 无关旧记忆（bug 根因）
    expect(content).not.toContain("先用 Read 检查同主题文件是否存在");
  });

  it("Read 条件化：有同主题才 Read 并更新，无则直接 Write 新文件", () => {
    expect(content).toContain("直接 Write 新文件");
    expect(content).toContain("不要 Read 任何不相关的旧记忆");
  });

  it("禁止把旧记忆当格式模板 Read", () => {
    expect(content).toContain("不要为看格式去 Read 旧记忆");
  });
});
