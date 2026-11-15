// Times are always shown in London time; durations in plain words.

export const LONDON = "Europe/London";

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, weekday: "short", day: "numeric", month: "short" });
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, day: "numeric", month: "long", year: "numeric" });
const keyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" });

function londonDayKey(date: Date) {
  return keyFormat.format(date);
}

export function clockTime(value: string | number | Date) {
  return timeFormat.format(new Date(value));
}

/** "14:05", "yesterday 14:05", "Mon 3 Nov, 14:05" */
export function when(value: string | number | Date, now = new Date()) {
  const date = new Date(value);
  const today = londonDayKey(now);
  const yesterday = londonDayKey(new Date(now.getTime() - 24 * 3600_000));
  const key = londonDayKey(date);
  if (key === today) return `${clockTime(date)}`;
  if (key === yesterday) return `yesterday ${clockTime(date)}`;
  return `${dayFormat.format(date)}, ${clockTime(date)}`;
}

/** Like `when`, but reads naturally after "since"/"at": "today at 14:05" style for headings. */
export function whenLong(value: string | number | Date, now = new Date()) {
  const date = new Date(value);
  const key = londonDayKey(date);
  if (key === londonDayKey(now)) return `today at ${clockTime(date)}`;
  if (key === londonDayKey(new Date(now.getTime() - 24 * 3600_000))) return `yesterday at ${clockTime(date)}`;
  return `${dayFormat.format(date)} at ${clockTime(date)}`;
}

export function longDate(value: string | number | Date) {
  return dateFormat.format(new Date(value));
}

/** 42 sec -> "less than a minute", 5400 -> "1 hr 30 min", 3 days -> "3 days" */
export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "less than a minute";
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  if (days < 7 && restHours) return `${plural(days, "day")} ${restHours} hr`;
  return plural(days, "day");
}

export function hoursAsDuration(hours: number) {
  return duration(hours * 3600);
}

/** "just now", "4 min ago", "3 hr ago", "2 days ago" */
export function ago(value: string | number | Date, now = Date.now()) {
  const seconds = (now - new Date(value).getTime()) / 1000;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

export function plural(count: number, word: string, pluralWord = `${word}s`) {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

export function videoLength(ms: number | null) {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} sec`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function distance(metres: number) {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  const miles = metres / 1609.34;
  return miles < 10 ? `${miles.toFixed(1)} miles` : `${Math.round(miles)} miles`;
}

/** Video names are always shown in curly quotes inside sentences. */
export function quoted(name: string) {
  return `“${name}”`;
}
