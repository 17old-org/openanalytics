import { zonedDateStart } from '@openanalytics/domain'

/** One calendar day of a range, clipped to the range at both ends. */
export interface DailyWindow {
  /** The calendar date in the request's timezone, `YYYY-MM-DD`. */
  readonly date: string
  readonly from: string
  readonly to: string
}

/**
 * Upper bound on the loop, not a product limit: the route refuses any daily
 * breakdown long before this (see `MAX_DAILY_BREAKDOWN_DAYS` in `read-key.ts`),
 * so this only stops a malformed range from spinning.
 */
const MAX_WINDOWS = 400

/** The calendar date an instant falls on in an IANA zone. */
function zonedDate(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  return `${at('year')}-${at('month')}-${at('day')}`
}

/** The calendar date after `date`, by calendar arithmetic rather than +24h. */
function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * Split a half-open range into the calendar days it touches in `timeZone`.
 *
 * Each boundary is the day's start in that zone — `zonedDateStart`, the same
 * instant ClickHouse computes as `toDateTime(date, tz)` — so a day here is the
 * day the dashboard's own charts draw, including across a DST change, where a
 * day is 23 or 25 hours long rather than a fixed 24. A range that does not start
 * or end on a midnight keeps its partial first and last day, clipped to the
 * range, rather than being widened past what the caller asked for.
 */
export function dailyWindows(from: string, to: string, timeZone: string): DailyWindow[] {
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  const windows: DailyWindow[] = []
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return windows

  let date = zonedDate(fromMs, timeZone)
  for (let index = 0; index < MAX_WINDOWS; index += 1) {
    const next = nextDate(date)
    const nextStart = zonedDateStart(next, timeZone)
    const start = Math.max(fromMs, zonedDateStart(date, timeZone))
    const end = Math.min(toMs, nextStart)
    if (end > start) {
      windows.push({ date, from: new Date(start).toISOString(), to: new Date(end).toISOString() })
    }
    if (Number.isNaN(nextStart) || nextStart >= toMs) break
    date = next
  }
  return windows
}
