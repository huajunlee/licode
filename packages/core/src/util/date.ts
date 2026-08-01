/**
 * Format a Date as a local-calendar ISO date string `YYYY-MM-DD`.
 *
 * Uses LOCAL components (getFullYear/getMonth/getDate), NOT toISOString (UTC):
 * the memory date-normalization relies on a local "today" anchor that must agree
 * with `normalizeDates` (which computes from local components). Switching any
 * caller to toISOString would silently reintroduce a UTC/local disagreement.
 */
export function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
