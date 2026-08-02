import { describe, expect, it } from "vitest";
import { normalizeDates } from "./normalize-dates.js";

const AUG1 = new Date(2026, 7, 1); // 2026-08-01 (local), Saturday
const JAN1 = new Date(2026, 0, 1); // 2026-01-01 (local)
const JAN15 = new Date(2026, 0, 15); // 2026-01-15
const AUG5 = new Date(2026, 7, 5); // 2026-08-05 (Wed) — 跨月周

describe("normalizeDates · 年", () => {
  it("去年/前年/大前年/明年/后年/今年 @ 2026", () => {
    const t = "大前年 前年 去年 今年 明年 后年";
    expect(normalizeDates(t, AUG1)).toBe("2023年 2024年 2025年 2026年 2027年 2028年");
  });
});

describe("normalizeDates · 月", () => {
  it("上个月 @ 2026-08-01 -> 2026年7月", () => {
    expect(normalizeDates("上个月启动", AUG1)).toBe("2026年7月启动");
  });
  it("上个月 @ 2026-01-15 跨年 -> 2025年12月", () => {
    expect(normalizeDates("上个月启动", JAN15)).toBe("2025年12月启动");
  });
  it("上上个月/下个月/下下个月/本月/这个月", () => {
    expect(normalizeDates("上上个月 下个月 下下个月 本月 这个月", AUG1))
      .toBe("2026年6月 2026年9月 2026年10月 2026年8月 2026年8月");
  });
});

describe("normalizeDates · 日", () => {
  it("昨天/前天/大前天/明天/后天/今天 @ 2026-08-01", () => {
    expect(normalizeDates("昨天 前天 大前天 今天 明天 后天", AUG1))
      .toBe("2026年7月31日 2026年7月30日 2026年7月29日 2026年8月1日 2026年8月2日 2026年8月3日");
  });
  it("昨天 @ 2026-01-01 跨年 -> 2025年12月31日", () => {
    expect(normalizeDates("昨天", JAN1)).toBe("2025年12月31日");
  });
});

describe("normalizeDates · 周", () => {
  it("上周 @ 2026-08-05(跨月周) -> 2026-07-27~2026-08-02", () => {
    expect(normalizeDates("上周", AUG5)).toBe("2026-07-27~2026-08-02");
  });
  it("本周 @ 2026-08-05 -> 2026-08-03~2026-08-09（周一首日）", () => {
    expect(normalizeDates("本周", AUG5)).toBe("2026-08-03~2026-08-09");
    expect(normalizeDates("这周", AUG5)).toBe("2026-08-03~2026-08-09");
  });
  it("上上周/下周", () => {
    expect(normalizeDates("上上周 下周", AUG5)).toBe("2026-07-20~2026-07-26 2026-08-10~2026-08-16");
  });
});

describe("normalizeDates · 性质", () => {
  it("锚点可变：同一'去年' @ 2026 -> 2025年；@ 2027 -> 2026年", () => {
    expect(normalizeDates("去年", new Date(2026, 7, 1))).toBe("2025年");
    expect(normalizeDates("去年", new Date(2027, 7, 1))).toBe("2026年");
  });
  it("幂等：对已转换输出再跑无改动", () => {
    const once = normalizeDates("去年和昨天", AUG1);
    expect(normalizeDates(once, AUG1)).toBe(once);
  });
  it("幂等：纯绝对文本不碰", () => {
    expect(normalizeDates("2025年7月15日的记录", AUG1)).toBe("2025年7月15日的记录");
  });
  it("最长匹配：大前年优先于前年", () => {
    expect(normalizeDates("大前年和前年", AUG1)).toBe("2023年和2024年");
  });
  it("最长匹配：上上个月优先于上个月", () => {
    expect(normalizeDates("上上个月", AUG1)).toBe("2026年6月");
  });
  it("频率词保留：每周/每月/每天/每年 不转", () => {
    expect(normalizeDates("每周回顾 每月清点 每天站会 每年复盘", AUG1))
      .toBe("每周回顾 每月清点 每天站会 每年复盘");
  });
  it("共存：去年和2024年的对比", () => {
    expect(normalizeDates("去年和2024年的对比", AUG1)).toBe("2025年和2024年的对比");
  });
  it("空串与无相对词", () => {
    expect(normalizeDates("", AUG1)).toBe("");
    expect(normalizeDates("普通文本无日期", AUG1)).toBe("普通文本无日期");
  });
});
