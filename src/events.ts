import OpenAI from 'openai';
import { ScheduledEvent, Event, Config } from './types';
import { Cache } from './cache';
import { parse } from 'date-fns';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function convertToEvents(scheduledEvents: ScheduledEvent[], config: Config): Promise<Event[]> {
  console.log(`Step 7: Converting ${scheduledEvents.length} scheduled events to events...`);
  
  if (scheduledEvents.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }
  
  const cache = new Cache();
  
  // Check cache first
  const uncachedEvents: ScheduledEvent[] = [];
  const events: Event[] = [];
  let cacheHits = 0;

  for (const scheduledEvent of scheduledEvents) {
    const cachedEventDescription = cache.getConvertedEventCache(scheduledEvent.interesting_announcement.announcement.message.link, config.userInterests);
    if (cachedEventDescription !== null) {
      cacheHits++;
      // Update cached event description with current data (interests might have changed)
      const updatedEventDescription = {
        ...cachedEventDescription,
        date_time: scheduledEvent.start_datetime,
        met_interests: scheduledEvent.interesting_announcement.interests_matched,
        link: scheduledEvent.interesting_announcement.announcement.message.link
      };
      events.push({ event_description: updatedEventDescription });
    } else {
      uncachedEvents.push(scheduledEvent);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${scheduledEvents.length} events`);
  }

  if (uncachedEvents.length === 0) {
    console.log(`  All events cached, skipping GPT calls`);
    console.log(`  Created ${events.length} events`);
    return events;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedEvents.length; i += 5) {
    chunks.push(uncachedEvents.slice(i, i + 5));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);
    const prompt = `Convert these event messages into structured event information. Respond in English.

Messages:
${chunk.map((scheduledEvent, idx) => `${idx + 1}. 
Start time: ${scheduledEvent.start_datetime}
Interests: ${scheduledEvent.interesting_announcement.interests_matched.join(', ')}
Content: ${scheduledEvent.interesting_announcement.announcement.message.content.replace(/\n/g, ' ')}
Link: ${scheduledEvent.interesting_announcement.announcement.message.link}`).join('\n\n')}

CRITICAL: For each message, respond with EXACTLY this format (including the exact keywords TITLE:, SUMMARY:, DESCRIPTION:):
MESSAGE_NUMBER:
TITLE: [short catchy title in English]
SUMMARY: [1-2 sentence summary in English - DO NOT mention dates/times as they are displayed separately]
DESCRIPTION: [full description from the message, can be original language]

Example:
1:
TITLE: JavaScript Meetup
SUMMARY: Monthly meetup for JS developers to share knowledge and network.
DESCRIPTION: Join us for our monthly JavaScript meetup where we discuss latest trends, share projects, and network with fellow developers.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      });

      const result = response.choices[0].message.content?.trim();
      if (result) {
        const eventBlocks = result.split(/^\d+:/m).filter(block => block.trim());
        
        for (let i = 0; i < eventBlocks.length && i < chunk.length; i++) {
          const block = eventBlocks[i];
          
          // Find TITLE, SUMMARY, DESCRIPTION using more robust matching
          const titleMatch = block.match(/\bTITLE:\s*(.+?)(?=\n|$)/i);
          const summaryMatch = block.match(/\bSUMMARY:\s*(.+?)(?=\n\s*DESCRIPTION:|$)/is);
          const descriptionMatch = block.match(/\bDESCRIPTION:\s*([\s\S]*?)(?=\n\s*Link:|$)/i);
          
          const title = titleMatch ? titleMatch[1].trim() : '';
          const summary = summaryMatch ? summaryMatch[1].trim() : '';
          const description = descriptionMatch ? descriptionMatch[1].trim() : '';
          
          const eventDescriptionData = {
            title: title || 'Event',
            short_summary: summary || 'Event details not extracted properly'
          };

          const eventDescription = {
            date_time: chunk[i].start_datetime,
            met_interests: chunk[i].interesting_announcement.interests_matched,
            ...eventDescriptionData,
            link: chunk[i].interesting_announcement.announcement.message.link
          };

          events.push({ event_description: eventDescription });

          // Cache the extracted event description data (without dynamic fields like date_time and interests)
          cache.cacheConvertedEvent(chunk[i].interesting_announcement.announcement.message.link, eventDescriptionData, config.userInterests, false);
          
          if (title && summary && description) {
            console.log(`    ✓ Created event: ${title}`);
          } else {
            console.log(`    ✗ Failed to extract complete event info for ${chunk[i].interesting_announcement.announcement.message.link}`);
          }
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Save cache after processing batch
    cache.save();
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Created ${events.length} events`);
  return events;
}

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
      const dateA = parse(a.event_description.date_time, 'dd MMM yyyy HH:mm', new Date());
      const dateB = parse(b.event_description.date_time, 'dd MMM yyyy HH:mm', new Date());
      return dateA.getTime() - dateB.getTime();
    } catch (error) {
      // If date parsing fails, keep original order
      return 0;
    }
  });

  sortedEvents.forEach((event, index) => {
    console.log(`${index + 1}. ${event.event_description.title}`);
    console.log(`   📅 ${event.event_description.date_time}`);
    console.log(`   🏷️ ${event.event_description.met_interests.join(', ')}`);
    console.log(`   📝 ${event.event_description.short_summary}`);
    console.log(`   🔗 ${event.event_description.link}`);
    console.log('');
  });
  
  console.log(`Total events found: ${events.length}`);
}