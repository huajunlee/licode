import { describe, it, expect, afterEach } from "vitest";

// readDiaryFlags 是 hooks.ts 顶层导出（参照 readContextFlags 的可测性）
import { readDiaryFlags } from "./hooks.js";

describe("readDiaryFlags", () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it("enabled by default, model defaults to deepseek-chat", () => {
    delete process.env.LICODE_DIARY;
    delete process.env.LICODE_DIARY_MODEL;
    const f = readDiaryFlags();
    expect(f.enabled).toBe(true);
    expect(f.model).toBe("deepseek-chat");
  });

  it("LICODE_DIARY=off disables", () => {
    process.env.LICODE_DIARY = "off";
    expect(readDiaryFlags().enabled).toBe(false);
  });

  it("LICODE_DIARY_MODEL overrides model", () => {
    process.env.LICODE_DIARY_MODEL = "gpt-4o-mini";
    expect(readDiaryFlags().model).toBe("gpt-4o-mini");
  });

  it("curateModel defaults to LICODE_DIARY_MODEL then deepseek-chat", () => {
    delete process.env.LICODE_DIARY_MODEL;
    delete process.env.LICODE_DIARY_CURATE_MODEL;
    expect(readDiaryFlags().curateModel).toBe("deepseek-chat");
    process.env.LICODE_DIARY_MODEL = "gpt-4o-mini";
    expect(readDiaryFlags().curateModel).toBe("gpt-4o-mini");
    process.env.LICODE_DIARY_CURATE_MODEL = "stronger-model";
    expect(readDiaryFlags().curateModel).toBe("stronger-model");
  });
});
