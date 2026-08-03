import { describe, it, expect } from "vitest";
import { inferPurpose } from "./thinking-accordion.js";

describe("inferPurpose", () => {
  it('returns "读取" when thinking mentions reading-related keywords', () => {
    expect(inferPurpose("let me read the app.tsx file")).toMatch(/读取/);
    expect(inferPurpose("I'm reading through the config")).toMatch(/读取/);
    expect(inferPurpose("looking at the codebase")).toMatch(/读取/);
  });

  it('returns "搜索" when thinking mentions searching-related keywords', () => {
    expect(inferPurpose("let me search for this function")).toMatch(/搜索/);
    expect(inferPurpose("finding where login is called")).toMatch(/搜索/);
    expect(inferPurpose("I need to grep this pattern")).toMatch(/搜索/);
  });

  it('returns "编辑" when thinking mentions editing-related keywords', () => {
    expect(inferPurpose("let me edit this file")).toMatch(/编辑/);
    expect(inferPurpose("modifying the component now")).toMatch(/编辑/);
    expect(inferPurpose("I will write the new hook")).toMatch(/编辑/);
    expect(inferPurpose("updating the config")).toMatch(/编辑/);
  });

  it('returns "分析" when thinking mentions analyzing-related keywords', () => {
    expect(inferPurpose("let me analyze this bug")).toMatch(/分析/);
    expect(inferPurpose("understanding the logic here")).toMatch(/分析/);
    expect(inferPurpose("debugging this issue step by step")).toMatch(/分析/);
    expect(inferPurpose("thinking through the approach")).toMatch(/分析/);
  });

  it("returns fallback 思考 when no keywords match", () => {
    const result = inferPurpose("xyzzy flobble wobble");
    expect(result).toMatch(/思考/);
  });

  it("returns first match when multiple categories match", () => {
    const result = inferPurpose("I will read the file and then edit it");
    expect(result).toMatch(/读取/);
  });

  // DeepSeek V4 outputs reasoning in Chinese
  it("matches Chinese reading keywords", () => {
    expect(inferPurpose("我来读取一下这个文件的内容")).toMatch(/读取/);
    expect(inferPurpose("先看看项目结构")).toMatch(/读取/);
  });

  it("matches Chinese searching keywords", () => {
    expect(inferPurpose("搜索一下这个函数在哪里定义的")).toMatch(/搜索/);
    expect(inferPurpose("查找所有调用 login 的地方")).toMatch(/搜索/);
  });

  it("matches Chinese editing keywords", () => {
    expect(inferPurpose("需要修改这个文件的逻辑")).toMatch(/编辑/);
    expect(inferPurpose("我来写一个新的 hooks")).toMatch(/编辑/);
    expect(inferPurpose("更新配置文件")).toMatch(/编辑/);
  });

  it("matches Chinese analysis keywords", () => {
    expect(inferPurpose("分析一下这个 bug 的原因")).toMatch(/分析/);
    expect(inferPurpose("我们来思考一下这个问题")).toMatch(/分析/);
    expect(inferPurpose("需要了解这个模块的功能")).toMatch(/分析/);
  });
  it("purpose labels contain no emoji", () => {
    const samples = [
      "read the file",
      "搜索一下",
      "edit this file",
      "analyze the bug",
      "xyzzy flobble",
    ];
    for (const s of samples) {
      expect(inferPurpose(s)).not.toMatch(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]|⏳|⚙/u
      );
    }
  });
});
