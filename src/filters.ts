import OpenAI from 'openai';
import { TelegramMessage, InterestingMessage, ScheduledMessage, Config } from './types';
import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';
import { Cache } from './cache';

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
  const cache = new Cache();
  console.log(`Step 3: Using GPT to filter ${messages.length} messages for event announcements...`);
  
  // Check cache first
  const uncachedMessages: TelegramMessage[] = [];
  const eventMessages: TelegramMessage[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedResult = cache.getEventResult(message.link);
    if (cachedResult !== null) {
      cacheHits++;
      if (cachedResult) {
        eventMessages.push(message);
      }
    } else {
      uncachedMessages.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  GPT identified ${eventMessages.length} event announcements`);
    return eventMessages;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const prompt = `Analyze these messages and identify which ones are announcements for a SINGLE SPECIFIC EVENT.

CRITICAL: You must EXCLUDE any message that:
- Lists multiple events or contains phrases like "events this week", "upcoming events", "event digest"
- Contains multiple dates or mentions several different activities
- Is a schedule or calendar listing
- Mentions "events" in plural form
- Is a roundup or compilation of events

ONLY INCLUDE messages that announce ONE specific event with:
- One specific date/time
- One specific activity/event
- Clear event details (title, location, etc.)

Messages:
${chunk.map((msg, idx) => `${idx + 1}. ${msg.content}`).join('\n\n')}

Respond with only the numbers of messages that are SINGLE event announcements, separated by commas (e.g., "1,3,7"). If none qualify, respond with "none".`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result && result !== 'none') {
        const indices = result.split(',').map(n => parseInt(n.trim()) - 1);
        for (const idx of indices) {
          if (idx >= 0 && idx < chunk.length) {
            eventMessages.push(chunk[idx]);
            cache.setEventResult(chunk[idx].link, true);
          }
        }
        
        // Cache negative results too
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!indices.includes(idx)) {
            cache.setEventResult(chunk[idx].link, false);
          }
        }
      } else {
        // All messages in chunk are not events
        for (const message of chunk) {
          cache.setEventResult(message.link, false);
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
  const cache = new Cache();
  console.log(`Step 4: Filtering ${messages.length} messages by user interests...`);
  
  // Check cache first
  const uncachedMessages: TelegramMessage[] = [];
  const interestingMessages: InterestingMessage[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedInterests = cache.getInterestResult(message.link);
    if (cachedInterests !== null) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        interestingMessages.push({
          message,
          interests_matched: cachedInterests
        });
      }
    } else {
      uncachedMessages.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Found ${interestingMessages.length} messages matching user interests`);
    return interestingMessages;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

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
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result) {
        const lines = result.split('\n').filter(line => line.includes(':'));
        const processedMessages = new Set<number>();
        
        for (const line of lines) {
          const [numPart, interestsPart] = line.split(':');
          const messageIdx = parseInt(numPart.trim()) - 1;
          const interests = interestsPart.split(',').map(s => s.trim()).filter(s => s);
          
          if (messageIdx >= 0 && messageIdx < chunk.length && interests.length > 0) {
            interestingMessages.push({
              message: chunk[messageIdx],
              interests_matched: interests
            });
            cache.setInterestResult(chunk[messageIdx].link, interests);
            processedMessages.add(messageIdx);
          }
        }
        
        // Cache empty results for unmatched messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedMessages.has(idx)) {
            cache.setInterestResult(chunk[idx].link, []);
          }
        }
      } else {
        // No matches in this chunk
        for (const message of chunk) {
          cache.setInterestResult(message.link, []);
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
  const cache = new Cache();
  console.log(`Step 5: Filtering ${messages.length} messages by schedule and future dates...`);
  
  // Check cache first
  const uncachedMessages: InterestingMessage[] = [];
  const scheduledMessages: ScheduledMessage[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedDateTime = cache.getScheduleResult(message.message.link);
    if (cachedDateTime !== null) {
      cacheHits++;
      if (cachedDateTime !== 'unknown') {
        // Re-validate against current time and schedule
        try {
          let eventDate: Date;
          if (cachedDateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/)) {
            eventDate = parse(cachedDateTime + ':00', 'dd MMM yyyy HH:mm', new Date());
          } else {
            eventDate = parse(cachedDateTime, 'dd MMM yyyy HH:mm', new Date());
          }
          
          const now = new Date();
          if (eventDate > now) {
            const dayOfWeek = getDay(eventDate);
            const hour = getHours(eventDate);
            const minute = getMinutes(eventDate);
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            
            const matchesSchedule = config.weeklyTimeslots.some(slot => {
              const [slotDay, slotTime] = slot.split(' ');
              const slotDayNum = parseInt(slotDay);
              return slotDayNum === dayOfWeek && timeStr >= slotTime;
            });
            
            if (matchesSchedule) {
              const properDateTime = cachedDateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? cachedDateTime + ':00' : cachedDateTime;
              scheduledMessages.push({
                interesting_message: message,
                start_datetime: properDateTime
              });
            }
          }
        } catch (error) {
          // If cached data is invalid, re-process
          uncachedMessages.push(message);
        }
      }
    } else {
      uncachedMessages.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Found ${scheduledMessages.length} messages matching schedule`);
    return scheduledMessages;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

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
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result) {
        const lines = result.split('\n').filter(line => line.includes(':'));
        const processedMessages = new Set<number>();
        
        for (const line of lines) {
          const [numPart, datePart] = line.split(':');
          const messageIdx = parseInt(numPart.trim()) - 1;
          const dateTime = datePart.trim();
          
          // Cache the extracted datetime
          if (messageIdx >= 0 && messageIdx < chunk.length) {
            cache.setScheduleResult(chunk[messageIdx].message.link, dateTime);
            processedMessages.add(messageIdx);
          }
          
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
              
              // Check if the event is in the future
              const now = new Date();
              if (eventDate <= now) {
                const properDateTime = dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
                console.log(`    ✗ Past event: ${properDateTime} - ${chunk[messageIdx].message.link}`);
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
                // Store the properly formatted date
                const properDateTime = dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
                
                scheduledMessages.push({
                  interesting_message: chunk[messageIdx],
                  start_datetime: properDateTime
                });
                
                console.log(`    ✓ Included: ${properDateTime} (day ${dayOfWeek}, ${timeStr}) - ${chunk[messageIdx].message.link}`);
              } else {
                const properDateTime = dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
                console.log(`    ✗ Filtered out: ${properDateTime} (day ${dayOfWeek}, ${timeStr}) - doesn't match timeslots ${config.weeklyTimeslots.join(', ')} - ${chunk[messageIdx].message.link}`);
              }
            } catch (error) {
              console.log(`    Could not parse date: ${dateTime}`);
            }
          }
        }
        
        // Cache 'unknown' for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedMessages.has(idx)) {
            cache.setScheduleResult(chunk[idx].message.link, 'unknown');
          }
        }
      } else {
        // No results from GPT, cache as unknown
        for (const message of chunk) {
          cache.setScheduleResult(message.message.link, 'unknown');
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