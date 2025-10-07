import OpenAI from 'openai';
import { Event, Config } from './types';
import { Cache } from './cache';
import { parse } from 'date-fns';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function describeEvents(events: Event[], config: Config): Promise<Event[]> {
  console.log(`Step 7: Converting ${events.length} scheduled events to events...`);

  if (events.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  const cache = new Cache();

  // Check cache first
  const uncachedEvents: Event[] = [];
  const describedEvents: Event[] = [];
  let cacheHits = 0;

  for (const event of events) {
    const cachedEventDescription = cache.getConvertedEventCache(event.message.link, config.userInterests);
    if (cachedEventDescription !== null) {
      cacheHits++;
      // Update cached event description with current data (interests might have changed)
      const updatedEventDescription = {
        ...cachedEventDescription,
        date_time: event.start_datetime!,
        met_interests: event.interests_matched!,
        link: event.message.link
      };
      describedEvents.push({ ...event, event_description: updatedEventDescription });
    } else {
      uncachedEvents.push(event);
    }
  }

  if (config.verboseLogging && cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${events.length} events`);
  }

  if (uncachedEvents.length === 0) {
    if (config.verboseLogging) {
      console.log(`  All events cached, skipping GPT calls`);
    }
    console.log(`  Created ${describedEvents.length} events`);
    return describedEvents;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedEvents.length; i += config.gptBatchSizeEventDescription) {
    chunks.push(uncachedEvents.slice(i, i + config.gptBatchSizeEventDescription));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (config.verboseLogging) {
      console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);
    }

    const eventsText = chunk.map((event, idx) => `${idx + 1}.
Start time: ${event.start_datetime}
Interests: ${event.interests_matched!.join(', ')}
Content: ${event.message.content.replace(/\n/g, ' ')}
Link: ${event.message.link}`).join('\n\n');

    const prompt = config.eventDescriptionPrompt!.replace('{{EVENTS}}', eventsText);

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
            date_time: chunk[i].start_datetime!,
            met_interests: chunk[i].interests_matched!,
            ...eventDescriptionData,
            link: chunk[i].message.link
          };

          describedEvents.push({ ...chunk[i], event_description: eventDescription });

          // Cache the extracted event description data (without dynamic fields like date_time and interests)
          cache.cacheConvertedEvent(chunk[i].message.link, eventDescriptionData, config.userInterests, false);

          if (config.verboseLogging) {
            if (title && summary && description) {
              console.log(`    ✓ Created event: ${title}`);
            } else {
              console.log(`    ✗ Failed to extract complete event info for ${chunk[i].message.link}`);
            }
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

  console.log(`  Created ${describedEvents.length} events`);
  return describedEvents;
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