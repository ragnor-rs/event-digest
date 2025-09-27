import OpenAI from 'openai';
import { TelegramMessage, InterestingMessage, ScheduledMessage, Config } from './types';
import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function filterEventMessages(messages: TelegramMessage[], config: Config): Promise<TelegramMessage[]> {
  console.log(`Step 2: Filtering ${messages.length} messages for event cues...`);
  
  const eventMessages = messages.filter(msg => {
    const content = msg.content.toLowerCase();
    for (const lang in config.eventMessageCues) {
      for (const cue of config.eventMessageCues[lang]) {
        if (content.includes(cue.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  });

  console.log(`  Found ${eventMessages.length} messages with event cues`);
  return eventMessages;
}

export async function filterWithGPT(messages: TelegramMessage[]): Promise<TelegramMessage[]> {
  console.log(`Step 3: Using GPT to filter ${messages.length} messages for event announcements...`);
  
  const chunks = [];
  for (let i = 0; i < messages.length; i += 16) {
    chunks.push(messages.slice(i, i + 16));
  }

  const eventMessages: TelegramMessage[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const prompt = `Analyze these messages and identify which ones are event announcements (concerts, meetups, conferences, workshops, etc.).

IMPORTANT: Only include messages about SINGLE specific events. Exclude:
- Event digests or lists of multiple events
- General announcements without specific events
- Recurring event series without specific dates

Messages:
${chunk.map((msg, idx) => `${idx + 1}. ${msg.content}`).join('\n\n')}

Respond with only the numbers of messages that are event announcements, separated by commas (e.g., "1,3,7"). If none are events, respond with "none".`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result && result !== 'none') {
        const indices = result.split(',').map(n => parseInt(n.trim()) - 1);
        for (const idx of indices) {
          if (idx >= 0 && idx < chunk.length) {
            eventMessages.push(chunk[idx]);
          }
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  GPT identified ${eventMessages.length} event announcements`);
  return eventMessages;
}

export async function filterByInterests(messages: TelegramMessage[], config: Config): Promise<InterestingMessage[]> {
  console.log(`Step 4: Filtering ${messages.length} messages by user interests...`);
  
  const chunks = [];
  for (let i = 0; i < messages.length; i += 16) {
    chunks.push(messages.slice(i, i + 16));
  }

  const interestingMessages: InterestingMessage[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const prompt = `Analyze these event messages and identify which user interests they match.

User interests: ${config.userInterests.join(', ')}

Messages:
${chunk.map((msg, idx) => `${idx + 1}. ${msg.content}`).join('\n\n')}

For each message that matches at least one interest, respond in this format:
MESSAGE_NUMBER: interest1, interest2
Example: 1: физика, ИИ

If a message doesn't match any interests, don't include it in your response.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result) {
        const lines = result.split('\n').filter(line => line.includes(':'));
        for (const line of lines) {
          const [numPart, interestsPart] = line.split(':');
          const messageIdx = parseInt(numPart.trim()) - 1;
          const interests = interestsPart.split(',').map(s => s.trim());
          
          if (messageIdx >= 0 && messageIdx < chunk.length && interests.length > 0) {
            interestingMessages.push({
              message: chunk[messageIdx],
              interests_matched: interests
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

  console.log(`  Found ${interestingMessages.length} messages matching user interests`);
  return interestingMessages;
}

export async function filterBySchedule(messages: InterestingMessage[], config: Config): Promise<ScheduledMessage[]> {
  console.log(`Step 5: Filtering ${messages.length} messages by schedule...`);
  
  const chunks = [];
  for (let i = 0; i < messages.length; i += 16) {
    chunks.push(messages.slice(i, i + 16));
  }

  const scheduledMessages: ScheduledMessage[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const prompt = `Extract the start date and time for each event. Today's date is ${new Date().toDateString()}.

Messages:
${chunk.map((msg, idx) => `${idx + 1}. ${msg.message.content}`).join('\n\n')}

For each message, respond in this format:
MESSAGE_NUMBER: DD MMM YYYY HH:MM
Example: 1: 08 Jan 2025 14:00
Example: 2: 15 Dec 2024 19:30

CRITICAL FORMAT REQUIREMENTS:
- ALWAYS use the exact format: DD MMM YYYY HH:MM (with colon between hours and minutes)
- Time MUST have both hours AND minutes (e.g., 18:00, NOT just 18)
- If time is missing, estimate a reasonable time (e.g., 19:00 for evening events)
- If you can't determine the complete date/time, use "unknown"
- NEVER use formats like "06 Sep 2025 18" - this is WRONG
- CORRECT: "06 Sep 2025 18:00"
- WRONG: "06 Sep 2025 18"`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result) {
        const lines = result.split('\n').filter(line => line.includes(':'));
        for (const line of lines) {
          const [numPart, datePart] = line.split(':');
          const messageIdx = parseInt(numPart.trim()) - 1;
          const dateTime = datePart.trim();
          
          if (messageIdx >= 0 && messageIdx < chunk.length && dateTime !== 'unknown') {
            try {
              let eventDate: Date;
              
              // Try multiple date formats
              if (dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/)) {
                // Format like "06 Sep 2025 18" - add :00 for minutes
                eventDate = parse(dateTime + ':00', 'dd MMM yyyy HH:mm', new Date());
              } else {
                // Standard format "06 Sep 2025 18:00"
                eventDate = parse(dateTime, 'dd MMM yyyy HH:mm', new Date());
              }
              
              // Check if the date is valid
              if (!isValid(eventDate)) {
                console.log(`    Could not parse date: "${dateTime}" from message: ${chunk[messageIdx].message.link}`);
                continue;
              }
              
              const dayOfWeek = getDay(eventDate);
              const hour = getHours(eventDate);
              const minute = getMinutes(eventDate);
              
              const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
              const dayTimeStr = `${dayOfWeek} ${timeStr}`;
              
              const matchesSchedule = config.weeklyTimeslots.some(slot => {
                const [slotDay, slotTime] = slot.split(' ');
                const slotDayNum = parseInt(slotDay);
                return slotDayNum === dayOfWeek && timeStr >= slotTime;
              });
              
              if (matchesSchedule) {
                scheduledMessages.push({
                  interesting_message: chunk[messageIdx],
                  start_datetime: dateTime
                });
                console.log(`    ✓ Included: ${dateTime} (day ${dayOfWeek}, ${timeStr}) - ${chunk[messageIdx].message.link}`);
              } else {
                console.log(`    ✗ Filtered out: ${dateTime} (day ${dayOfWeek}, ${timeStr}) - doesn't match timeslots ${config.weeklyTimeslots.join(', ')} - ${chunk[messageIdx].message.link}`);
              }
            } catch (error) {
              console.log(`    Could not parse date: ${dateTime}`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Found ${scheduledMessages.length} messages matching schedule`);
  return scheduledMessages;
}