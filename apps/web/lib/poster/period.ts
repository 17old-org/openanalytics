import type { AnalyticsRange } from "@/lib/api";

/**
 * The poster's date line for a range, in the range's own zone.
 *
 * The picker's label ("Last 30 days") says how long; this says which days,
 * because a picture posted next week has no picker beside it. `to` is
 * exclusive by contract, so a calendar range ends on the day before it:
 * "Aug 3 to Sep 1, 2026", not "to Sep 2". A range cut on the clock rather
 * than on midnights (the rolling 24 hours) keeps its times instead.
 */
export function posterPeriodDates(range: AnalyticsRange): string {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
  const zone = usableZone(range.timezone);
  const end = new Date(to.getTime() - 1);

  if (atMidnight(from, zone) && atMidnight(to, zone)) {
    if (dayKey(from, zone) === dayKey(end, zone)) return day(from, zone, true);
    const sameYear = yearOf(from, zone) === yearOf(end, zone);
    return `${day(from, zone, !sameYear)} to ${day(end, zone, true)}`;
  }
  return `${moment(from, zone)} to ${moment(to, zone)}`;
}

/** An unrecognised zone name falls back to UTC rather than throwing. */
function usableZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

function dayKey(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function yearOf(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
  }).format(at);
}

function atMidnight(at: Date, zone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour === "00" && minute === "00";
}

function day(at: Date, zone: string, withYear: boolean): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(at);
}

function moment(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
