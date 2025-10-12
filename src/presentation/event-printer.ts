import { Event } from '../domain/entities';
import { parse } from 'date-fns';

export function printEvents(events: Event[]): void {
  console.log('=== EVENT DIGEST ===');

  if (events.length === 0) {
    console.log('No events found matching your criteria.');
    return;
  }

  console.log('');

  // Sort events by date in chronological order
  const sortedEvents = events.sort((a, b) => {
    try {
      const dateA = parse(a.event_description!.date_time, 'dd MMM yyyy HH:mm', new Date());
      const dateB = parse(b.event_description!.date_time, 'dd MMM yyyy HH:mm', new Date());
      return dateA.getTime() - dateB.getTime();
    } catch (error) {
      // If date parsing fails, keep original order
      return 0;
    }
  });

  sortedEvents.forEach((event, index) => {
    console.log(`${index + 1}. ${event.event_description!.title}`);
    console.log(`   📅 ${event.event_description!.date_time}`);
    console.log(`   🏷️ ${event.event_description!.met_interests.join(', ')}`);
    console.log(`   📝 ${event.event_description!.short_summary}`);
    console.log(`   🔗 ${event.event_description!.link}`);
    console.log('');
  });

  console.log(`Total events found: ${events.length}`);
}
