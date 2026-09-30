import { DigestEvent, formatLocation } from '../domain/entities';

/**
 * Google Calendar's prefill endpoint. Not a contractual API, but long-standing
 * and widely used, and it needs no key, no OAuth and no client library — which
 * is the whole reason to prefer it here over the Calendar API.
 */
const GOOGLE_CALENDAR_TEMPLATE_URL = 'https://calendar.google.com/calendar/render';

/**
 * Length assumed for an event, in hours. Announcements say when something starts
 * and almost never when it ends, yet the endpoint wants a range, so this is a
 * guess — one the user can correct in the form before saving. Two hours is the
 * common shape of the talks, meetups and screenings this digest collects.
 */
const ASSUMED_EVENT_DURATION_HOURS = 2;

/** "20261007T160000Z" — the UTC stamp the endpoint expects for a timed event. */
function toUtcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * "20261007" in the event's own local date, for an all-day entry.
 * Read off the local parts rather than the ISO string, because an all-day entry
 * means a calendar day where the event happens, not an instant in UTC.
 */
function toLocalDateStamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Builds the `dates` range.
 *
 * A time-less event becomes an all-day entry rather than a two-hour block at the
 * noon `parseEventDateTime` parked it at: the date is the only thing the
 * announcement actually stated, and an all-day entry is the one shape that says
 * so. All-day ranges are plain local dates whose end is exclusive, hence +1 day.
 */
function formatDateRange(start: Date, timeKnown: boolean): string {
  if (!timeKnown) {
    const endOfDay = new Date(start);
    endOfDay.setDate(endOfDay.getDate() + 1);
    return `${toLocalDateStamp(start)}/${toLocalDateStamp(endOfDay)}`;
  }

  const end = new Date(start.getTime() + ASSUMED_EVENT_DURATION_HOURS * 60 * 60 * 1000);
  return `${toUtcStamp(start)}/${toUtcStamp(end)}`;
}

/**
 * Builds a link that opens Google Calendar's create form, prefilled from an event.
 *
 * `details` carries only the source link and not the summary: a batch of these
 * URLs shares the Telegram message length limit, and the summary is already on
 * screen directly above the link.
 */
export function buildGoogleCalendarUrl(event: DigestEvent): string {
  // Omitted when the post named no place, for the same reason the 📍 line is:
  // there is nothing to put in the field.
  const location = event.event_location ? formatLocation(event.event_location) : '';

  // The query is assembled by hand rather than with URLSearchParams, and the
  // difference is not cosmetic: URLSearchParams encodes a space as "+", and a
  // "+" anywhere in the URL breaks the Telegram reporter. GramJS screens every
  // link in an outgoing message against /^@|\+|tg:\/\/user\?id=(\d+)/ looking
  // for mentions, and that "\+" alternative is unanchored — so it takes the
  // whole calendar URL for a username, fails to resolve it, and drops the link
  // entity, leaving a label that renders cleanly and does nothing when tapped.
  // encodeURIComponent never emits a bare "+" (a literal one in a title becomes
  // %2B), and Google accepts %20 for spaces just as it accepts "+".
  const params = [
    'action=TEMPLATE',
    `text=${encodeURIComponent(event.event_description!.title)}`,
    `details=${encodeURIComponent(event.message.link)}`,
    ...(location ? [`location=${encodeURIComponent(location)}`] : []),
    // The range separator stays a literal "/": it is legal unencoded in a query
    // value, it is the form Google's own examples use, and the stamps either
    // side of it are only digits, "T" and "Z".
    `dates=${formatDateRange(event.start_datetime!, event.start_time_known !== false)}`,
  ];

  return `${GOOGLE_CALENDAR_TEMPLATE_URL}?${params.join('&')}`;
}
