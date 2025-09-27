import OpenAI from 'openai';
import { ScheduledMessage, Event } from './types';
import { Cache } from './cache';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function convertToEvents(messages: ScheduledMessage[]): Promise<Event[]> {
  const cache = new Cache();
  console.log(`Step 6: Converting ${messages.length} scheduled messages to events...`);
  
  // Check cache first
  const uncachedMessages: ScheduledMessage[] = [];
  const events: Event[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedEvent = cache.getEventConversion(message.interesting_message.message.link);
    if (cachedEvent !== null) {
      cacheHits++;
      // Update cached event with current data (interests might have changed)
      const updatedEvent = {
        ...cachedEvent,
        date_time: message.start_datetime,
        met_interests: message.interesting_message.interests_matched,
        link: message.interesting_message.message.link
      };
      events.push(updatedEvent);
    } else {
      uncachedMessages.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Created ${events.length} events`);
    return events;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 5) {
    chunks.push(uncachedMessages.slice(i, i + 5));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    const prompt = `Convert these event messages into structured event information.

Messages:
${chunk.map((msg, idx) => `${idx + 1}. 
Start time: ${msg.start_datetime}
Interests: ${msg.interesting_message.interests_matched.join(', ')}
Content: ${msg.interesting_message.message.content}
Link: ${msg.interesting_message.message.link}`).join('\n\n')}

For each message, create an event with this format:
MESSAGE_NUMBER:
TITLE: [short catchy title]
SUMMARY: [1-2 sentence summary]
DESCRIPTION: [full description from the message]

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
        const eventBlocks = result.split(/\d+:/).filter(block => block.trim());
        
        for (let i = 0; i < eventBlocks.length && i < chunk.length; i++) {
          const block = eventBlocks[i];
          const lines = block.split('\n').filter(line => line.trim());
          
          let title = '';
          let summary = '';
          let description = '';
          
          for (const line of lines) {
            if (line.startsWith('TITLE:')) {
              title = line.replace('TITLE:', '').trim();
            } else if (line.startsWith('SUMMARY:')) {
              summary = line.replace('SUMMARY:', '').trim();
            } else if (line.startsWith('DESCRIPTION:')) {
              description = line.replace('DESCRIPTION:', '').trim();
            }
          }
          
          const eventData = {
            title: title || 'Event',
            short_summary: summary || 'Event details not extracted properly',
            full_description: description || chunk[i].interesting_message.message.content.substring(0, 200) + '...'
          };

          const finalEvent = {
            date_time: chunk[i].start_datetime,
            met_interests: chunk[i].interesting_message.interests_matched,
            ...eventData,
            link: chunk[i].interesting_message.message.link
          };

          events.push(finalEvent);
          
          // Cache the extracted event data (without dynamic fields like date_time and interests)
          cache.setEventConversion(chunk[i].interesting_message.message.link, eventData);
          
          if (title && summary && description) {
            console.log(`    ✓ Created event: ${title}`);
          } else {
            console.log(`    ✗ Failed to extract complete event info for ${chunk[i].interesting_message.message.link}`);
          }
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Created ${events.length} events`);
  return events;
}

export function printEvents(events: Event[]): void {
  console.log('\n=== EVENT DIGEST ===\n');
  
  if (events.length === 0) {
    console.log('No events found matching your criteria.');
    return;
  }

  events.forEach((event, index) => {
    console.log(`${index + 1}. ${event.title}`);
    console.log(`   📅 ${event.date_time}`);
    console.log(`   🏷️  ${event.met_interests.join(', ')}`);
    console.log(`   📝 ${event.short_summary}`);
    console.log(`   🔗 ${event.link}`);
    console.log('');
  });
  
  console.log(`Total events found: ${events.length}`);
}