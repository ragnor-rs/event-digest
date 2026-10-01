import { buildGoogleCalendarUrl } from './calendar-link';
import { IEventReporter } from './event-reporter.interface';
import { DigestEvent, formatLocation } from '../domain/entities';
import { formatEventDateTime } from '../shared/date-utils';

/**
 * Prints events to console in a formatted display
 */
export class EventPrinter implements IEventReporter {
  /**
   * Print events to console
   */
  async report(events: DigestEvent[]): Promise<void> {
    const today = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    console.log(`=== EVENT DIGEST (${today}) ===`);

    if (events.length === 0) {
      console.log('No events found matching your criteria.');
      return;
    }

    console.log('');

    // Validate all events have required fields
    const validEvents = events.filter((event) => {
      if (!event.event_description) {
        console.error(`Warning: Event missing description, skipping: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.start_datetime) {
        console.error(`Warning: Event missing start_datetime, skipping: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.event_description.title) {
        console.error(`Warning: Event missing title, skipping: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.event_description.short_summary) {
        console.error(`Warning: Event missing short_summary, skipping: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.interest_matches || event.interest_matches.length === 0) {
        console.error(`Warning: Event missing interest_matches, skipping: ${event.message?.link || 'unknown'}`);
        return false;
      }
      return true;
    });

    if (validEvents.length < events.length) {
      console.error(`\nFiltered out ${events.length - validEvents.length} invalid event(s)\n`);
    }

    // Sort events by date in chronological order
    const sortedEvents = validEvents.sort((a, b) => {
      return a.start_datetime!.getTime() - b.start_datetime!.getTime();
    });

    sortedEvents.forEach((event, index) => {
      console.log(`${index + 1}. ${event.event_description!.title}`);
      console.log(`   📅 ${formatEventDateTime(event.start_datetime!, event.start_time_known !== false)}`);
      // Omitted rather than shown as "unknown": an announcement that named no
      // venue has nothing to print, and a placeholder line only adds noise.
      const where = event.event_location ? formatLocation(event.event_location) : '';
      if (where) {
        console.log(`   📍 ${where}`);
      }
      console.log(`   🏷️ ${event.interest_matches!.map((m) => m.interest).join(', ')}`);
      console.log(`   📝 ${event.event_description!.short_summary}`);
      // Duplicates collapsed in step 9 join the link line rather than getting
      // their own: they are the same event, so one list of places it was posted.
      const links = [event.message.link, ...(event.duplicate_sources?.map((m) => m.link) ?? [])];
      console.log(`   🔗 ${links.join(', ')}`);
      console.log(`   ➕ ${buildGoogleCalendarUrl(event)}`);
      console.log('');
    });

    console.log(`Total events found: ${sortedEvents.length}`);
  }
}
