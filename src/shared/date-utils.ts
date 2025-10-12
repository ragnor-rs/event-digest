/**
 * Date format used throughout the application for displaying event dates.
 * Format: day (2 digits) month (3 letter abbrev) year (4 digits) hour:minute (24h)
 * Example: "06 Sep 2025 18:00"
 */
export const DATE_FORMAT = 'dd MMM yyyy HH:mm';

// Single source of truth for date normalization
export function normalizeDateTime(dateTime: string): string {
  if (dateTime === 'unknown') return dateTime;
  // Fix incomplete format: "06 Sep 2025 18" → "06 Sep 2025 18:00"
  return dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
}

export const MAX_FUTURE_YEARS = 2;
