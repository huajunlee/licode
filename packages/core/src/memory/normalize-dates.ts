/**
 * 把 `text` 里的点时间相对词（去年/昨天/上周/上个月…）换成绝对日期，锚点 `now`。
 *
 * - 精确词程序化确定性换算；模糊词（最近/前阵子）不动，交 LLM。
 * - 频率词（每周/每月/每天/每年）不入表——它们不是点时间，转换会破坏语义。
 * - 幂等：输出不含相对词，再跑无匹配无改动。
 * - 最长匹配优先：大前年先于前年、上上个月先于上个月，正则按长度降序交替。
 * - 无新依赖：用 Date 构造函数做年/月/日进位（`new Date(y, m±n, d)` 自动跨年跨月）。
 */
import { formatLocalDate } from "../util/date.js";

export function normalizeDates(text: string, now: Date = new Date()): string {
  if (!text) return text;

  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const d = now.getDate();

  const fmtY = (yy: number) => `${yy}年`;
  const fmtM = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月`;
  const fmtD = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const iso = (date: Date) => formatLocalDate(date);
  // 周一为首日：本周一 = 今天 - (day+6)%7
  const day = now.getDay(); // 0=Sun..6=Sat
  const thisMonday = new Date(y, m, d - ((day + 6) % 7));
  const fmtWeek = (monday: Date) => {
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return `${iso(monday)}~${iso(sunday)}`;
  };
  const addWeeks = (base: Date, n: number) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + n * 7);

  // 触发词按长度降序排列，避免子串误匹配（大前年先于前年…）。
  // 每条 [触发词, 绝对值]；绝对值由 now 一次算定。
  const entries: Array<[string, string]> = [
    // 年（3字先于2字）
    ["大前年", fmtY(y - 3)],
    ["前年", fmtY(y - 2)],
    ["去年", fmtY(y - 1)],
    ["今年", fmtY(y)],
    ["明年", fmtY(y + 1)],
    ["后年", fmtY(y + 2)],
    // 月（4字先于3字）
    ["上上个月", fmtM(new Date(y, m - 2, 1))],
    ["下下个月", fmtM(new Date(y, m + 2, 1))],
    ["上个月", fmtM(new Date(y, m - 1, 1))],
    ["下个月", fmtM(new Date(y, m + 1, 1))],
    ["这个月", fmtM(new Date(y, m, 1))],
    ["本月", fmtM(new Date(y, m, 1))],
    // 日（3字先于2字）
    ["大前天", fmtD(new Date(y, m, d - 3))],
    ["前天", fmtD(new Date(y, m, d - 2))],
    ["昨天", fmtD(new Date(y, m, d - 1))],
    ["今天", fmtD(new Date(y, m, d))],
    ["明天", fmtD(new Date(y, m, d + 1))],
    ["后天", fmtD(new Date(y, m, d + 2))],
    // 周（3字先于2字）
    ["上上周", fmtWeek(addWeeks(thisMonday, -2))],
    ["下周", fmtWeek(addWeeks(thisMonday, 1))],
    ["上周", fmtWeek(addWeeks(thisMonday, -1))],
    ["本周", fmtWeek(thisMonday)],
    ["这周", fmtWeek(thisMonday)],
  ];

  const lookup = new Map(entries);
  // 触发词均为 CJK 字符，无正则元字符，故 join("|") 无需转义；
  // 若将来加入含标点的 token，需重新审视此处的转义。
  const pattern = new RegExp(entries.map(([k]) => k).join("|"), "g");
  return text.replace(pattern, (match) => lookup.get(match) ?? match);
}
