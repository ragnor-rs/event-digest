import { format, isValid, parse } from 'date-fns';

/**
 * Date format used throughout the application for displaying event dates.
 * Format: day (2 digits) month (3 letter abbrev) year (4 digits) hour:minute (24h)
 * Example: "06 Sep 2025 18:00"
 */
export const DATE_FORMAT = 'dd MMM yyyy HH:mm';

/**
 * Date-only format, used when the announcement gives a day but no time.
 * Example: "27 Sep 2026"
 */
export const DATE_ONLY_FORMAT = 'dd MMM yyyy';

/**
 * Hour assigned to an event whose time is unknown. Midnight would make the
 * event look already past for most of its own day, so it is parked at noon.
 * Callers must still treat the time as unknown — see parseEventDateTime.
 */
export const UNKNOWN_TIME_HOUR = 12;

// Single source of truth for date normalization
export function normalizeDateTime(dateTime: string): string {
  if (dateTime === 'unknown') return dateTime;
  // Fix incomplete format: "06 Sep 2025 18" → "06 Sep 2025 18:00"
  return dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
}

/**
 * Splits a date-with-unknown-time string into its date part.
 * GPT emits "27 Sep 2026 unknown" when a post names the day but not the hour;
 * that string parses to Invalid Date, which is why such events were dropped.
 * Returns null when the string is not of that shape.
 */
export function extractDateWithoutTime(dateTime: string): string | null {
  const match = dateTime.trim().match(/^(\d{1,2} \w{3} \d{4})\s+unknown$/i);
  return match ? match[1].padStart(11, '0') : null;
}

export interface ParsedEventDateTime {
  date: Date;
  /** False when the source gave a day but no clock time. */
  timeKnown: boolean;
}

/**
 * Parses an extracted datetime, tolerating a known date with an unknown time.
 * Returns null if nothing usable could be parsed; callers check isValid on the
 * date themselves for the normal path.
 */
export function parseEventDateTime(dateTime: string): ParsedEventDateTime | null {
  if (dateTime === 'unknown') return null;

  const dateOnly = extractDateWithoutTime(dateTime);
  if (dateOnly) {
    const date = parse(dateOnly, DATE_ONLY_FORMAT, new Date());
    if (!isValid(date)) return null;
    date.setHours(UNKNOWN_TIME_HOUR, 0, 0, 0);
    return { date, timeKnown: false };
  }

  const date = parse(normalizeDateTime(dateTime), DATE_FORMAT, new Date());
  return isValid(date) ? { date, timeKnown: true } : null;
}

/** Formats an event date, omitting the time when it was never known. */
export function formatEventDateTime(date: Date, timeKnown: boolean = true): string {
  return timeKnown ? format(date, DATE_FORMAT) : `${format(date, DATE_ONLY_FORMAT)} (time TBA)`;
}

/**
 * Formats a Date object to the standard application date format
 * Example: Date -> "06 Sep 2025 18:00"
 */
export function formatDateTime(date: Date): string {
  return format(date, DATE_FORMAT);
}

export const MAX_FUTURE_YEARS = 2;
