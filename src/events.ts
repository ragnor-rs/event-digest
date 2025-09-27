import OpenAI from 'openai';
import { ScheduledMessage, Event } from './types';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function convertToEvents(messages: ScheduledMessage[]): Promise<Event[]> {
  console.log(`Step 6: Converting ${messages.length} scheduled messages to events...`);
  
  const chunks = [];
  for (let i = 0; i < messages.length; i += 5) {
    chunks.push(messages.slice(i, i + 5));
  }

  const events: Event[] = [];

  for (const chunk of chunks) {
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
        model: 'gpt-4',
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
          
          if (title && summary && description) {
            events.push({
              date_time: chunk[i].start_datetime,
              met_interests: chunk[i].interesting_message.interests_matched,
              title,
              short_summary: summary,
              full_description: description,
              link: chunk[i].interesting_message.message.link
            });
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