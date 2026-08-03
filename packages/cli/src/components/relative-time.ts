/** Format an ISO timestamp as Chinese relative time. `now` is injected for testability. */
export function relativeTime(iso: string, now: Date): string {
  const diffSec = Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso).getTime()) / 1000)
  );
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
