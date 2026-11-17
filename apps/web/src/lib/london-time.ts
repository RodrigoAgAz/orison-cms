// Europe/London calendar helpers. The business runs in London: every "today / this week / this
// month" boundary, chart day and export date on the desktop is a London calendar day (BST
// included), whatever the server's own clock zone is (UTC on Railway).

export const LONDON_TZ = "Europe/London";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKeyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function londonParts(instant: Date) {
  const parts = partsFormatter.formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** London's offset from UTC at an instant, in ms (0 in winter, +1 h during BST). */
export function londonOffsetMs(instant: Date) {
  const p = londonParts(instant);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The London calendar date of an instant, as "yyyy-mm-dd". */
export function londonDayKey(instant: Date) {
  const p = londonParts(instant);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = dayKeyPattern.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function keyToUtcMidnight(key: string) {
  if (!isDayKey(key)) {
    throw new Error(`Not a calendar date: ${key}`);
  }
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** "yyyy-mm-dd" shifted by whole calendar days. */
export function addDaysToKey(key: string, days: number) {
  return new Date(keyToUtcMidnight(key) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant London midnight starts on a calendar date (23:00 UTC the day before during BST). */
export function londonDayStart(key: string) {
  const wallMidnight = keyToUtcMidnight(key);
  // Clocks change at 01:00 UTC, so the offset at (midnight - offset) is the offset at midnight.
  let candidate = wallMidnight - londonOffsetMs(new Date(wallMidnight));
  candidate = wallMidnight - londonOffsetMs(new Date(candidate));
  return new Date(candidate);
}

/** [start, end) of a London calendar date. 23 or 25 hours long on clock-change days. */
export function londonDayRange(key: string) {
  return { start: londonDayStart(key), end: londonDayStart(addDaysToKey(key, 1)) };
}

/** Every calendar date from `fromKey` to `toKey` inclusive. */
export function dayKeysBetween(fromKey: string, toKey: string) {
  const keys: string[] = [];
  for (let key = fromKey; key <= toKey; key = addDaysToKey(key, 1)) {
    keys.push(key);
  }
  return keys;
}

/** Monday of the London week containing `key`. */
export function weekStartKey(key: string) {
  const weekday = new Date(keyToUtcMidnight(key)).getUTCDay(); // 0 = Sunday
  return addDaysToKey(key, -((weekday + 6) % 7));
}

export function monthStartKey(key: string) {
  return `${key.slice(0, 8)}01`;
}

/** London calendar boundaries for "today", "this week" (Monday start) and "this month". */
export function londonPeriods(now: Date = new Date()) {
  const todayKey = londonDayKey(now);
  const weekKey = weekStartKey(todayKey);
  const monthKey = monthStartKey(todayKey);
  return {
    todayKey,
    weekStartKey: weekKey,
    monthStartKey: monthKey,
    todayStart: londonDayStart(todayKey),
    weekStart: londonDayStart(weekKey),
    monthStart: londonDayStart(monthKey),
  };
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON_TZ,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON_TZ,
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "17 Nov 2026, 14:05" in London time. */
export function formatLondonDateTime(value: Date | string | null | undefined, fallback = "Never") {
  if (!value) {
    return fallback;
  }
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? fallback : dateTimeFormatter.format(date);
}

export function formatLondonDate(value: Date | string | null | undefined, fallback = "Never") {
  if (!value) {
    return fallback;
  }
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? fallback : dateFormatter.format(date);
}

/** A "yyyy-mm-dd" calendar date as "17 Nov" (no zone conversion: it already is a London date). */
export function formatDayKeyShort(key: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(
    new Date(keyToUtcMidnight(key)),
  );
}

/** "2026-11-17 14:05:09" in London time, for CSV files (sortable, spreadsheet-friendly). */
export function formatLondonCsvTime(instant: Date) {
  const p = londonParts(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
