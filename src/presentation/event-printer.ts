import { DigestEvent } from '../domain/entities';
import { formatDateTime } from '../shared/date-utils';

export function printEvents(events: DigestEvent[]): void {
  console.log('=== EVENT DIGEST ===');

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
    if (!event.interests_matched || event.interests_matched.length === 0) {
      console.error(`Warning: Event missing interests_matched, skipping: ${event.message?.link || 'unknown'}`);
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
    console.log(`   📅 ${formatDateTime(event.start_datetime!)}`);
    console.log(`   🏷️  ${event.interests_matched!.join(', ')}`);
    console.log(`   📝 ${event.event_description!.short_summary}`);
    console.log(`   🔗 ${event.message.link}`);
    console.log('');
  });

  console.log(`Total events found: ${sortedEvents.length}`);
}
