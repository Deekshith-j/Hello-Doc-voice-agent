// Formats dates, durations, and labels for operator screens in an explicit time zone.
// Every helper takes the zone as an argument so server rendering never depends on the host's clock zone.
const dateTimeCache = new Map<string, Intl.DateTimeFormat>();

function formatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let cached = dateTimeCache.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    dateTimeCache.set(key, cached);
  }
  return cached;
}

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function formatTime(value: Date | string | number, timeZone: string): string {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(
    toDate(value),
  );
}

export function formatDay(value: Date | string | number, timeZone: string): string {
  return formatter(timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(toDate(value));
}

export function formatDateTime(value: Date | string | number, timeZone: string): string {
  const d = toDate(value);
  return `${formatDay(d, timeZone)}, ${formatTime(d, timeZone)}`;
}

export function formatTimeZoneName(value: Date | string | number, timeZone: string): string {
  const d = toDate(value);
  const part = formatter(timeZone, { timeZoneName: "short" })
    .formatToParts(d)
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? timeZone;
}

// Returns YYYY-MM-DD for the calendar day that `value` falls on in `timeZone`.
export function localDateKey(value: Date | string | number, timeZone: string): string {
  return formatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(toDate(value))
    .replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2");
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function callDurationSeconds(
  startedAt: Date,
  endedAt: Date | null,
): number | null {
  if (!endedAt) return null;
  return (endedAt.getTime() - startedAt.getTime()) / 1_000;
}

export function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const weekdayNames = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export function maskPhone(phone: string): string {
  if (!phone) return "";
  const trimmed = phone.trim();
  if (trimmed.length <= 2) return trimmed;
  const last2 = trimmed.slice(-2);
  const maskedPrefix = "•".repeat(trimmed.length - 2);
  return `${maskedPrefix}${last2}`;
}
