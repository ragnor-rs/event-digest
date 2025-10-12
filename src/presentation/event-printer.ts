import { parse } from 'date-fns';

import { Event } from '../domain/entities';

export function printEvents(events: Event[]): void {
  console.log('=== EVENT DIGEST ===');

  if (events.length === 0) {
    console.log('No events found matching your criteria.');
    return;
  }

  console.log('');

  // Validate all events have required description fields
  const validEvents = events.filter((event) => {
    if (!event.event_description) {
      console.error(`Warning: Event missing description, skipping: ${event.message?.link || 'unknown'}`);
      return false;
    }
    if (!event.event_description.date_time) {
      console.error(`Warning: Event missing date_time, skipping: ${event.message?.link || 'unknown'}`);
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
    if (!event.event_description.link) {
      console.error(`Warning: Event missing link, skipping: ${event.message?.link || 'unknown'}`);
      return false;
    }
    if (!event.event_description.met_interests || event.event_description.met_interests.length === 0) {
      console.error(`Warning: Event missing met_interests, skipping: ${event.message?.link || 'unknown'}`);
      return false;
    }
    return true;
  });

  if (validEvents.length < events.length) {
    console.error(`\nFiltered out ${events.length - validEvents.length} invalid event(s)\n`);
  }

  // Sort events by date in chronological order
  const sortedEvents = validEvents.sort((a, b) => {
    try {
      const dateA = parse(a.event_description!.date_time, 'dd MMM yyyy HH:mm', new Date());
      const dateB = parse(b.event_description!.date_time, 'dd MMM yyyy HH:mm', new Date());
      return dateA.getTime() - dateB.getTime();
    } catch (error) {
      console.error(
        `Warning: Failed to parse dates for sorting (${a.event_description!.date_time} vs ${b.event_description!.date_time}): ${error instanceof Error ? error.message : String(error)}`
      );
      return 0;
    }
  });

  sortedEvents.forEach((event, index) => {
    console.log(`${index + 1}. ${event.event_description!.title}`);
    console.log(`   📅 ${event.event_description!.date_time}`);
    console.log(`   🏷️  ${event.event_description!.met_interests.join(', ')}`);
    console.log(`   📝 ${event.event_description!.short_summary}`);
    console.log(`   🔗 ${event.event_description!.link}`);
    console.log('');
  });

  console.log(`Total events found: ${sortedEvents.length}`);
}
