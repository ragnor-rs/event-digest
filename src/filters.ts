import OpenAI from 'openai';
import { TelegramMessage, InterestingMessage, ScheduledMessage, Config } from './types';
import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';
import { Cache } from './cache';

// Single source of truth for date normalization
function normalizeDateTime(dateTime: string): string {
  if (dateTime === 'unknown') return dateTime;
  // Fix incomplete format: "06 Sep 2025 18" → "06 Sep 2025 18:00"
  return dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
}

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
  
  const cache = new Cache();

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
${chunk.map((msg, idx) => `${idx + 1}. ${msg.content.replace(/\n/g, ' ')}`).join('\n\n')}

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
    const cachedInterests = cache.getInterestResult(message.link, config.userInterests);
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
    
    const prompt = `Analyze these event messages and identify which user interests they match. Be VERY STRICT - only match if the event is DIRECTLY about the interest topic as the main subject.

User interests: ${config.userInterests.join(', ')}

CRITICAL MATCHING RULES:
- Only match if the event's PRIMARY topic/focus is about the interest
- Do NOT match events that merely mention the interest in passing
- Do NOT match events conducted in a language but not ABOUT that language
- Do NOT match events by speakers who happen to have expertise in an interest area
- The event content must be specifically designed for people interested in that topic

Messages:
${chunk.map((msg, idx) => `${idx + 1}. ${msg.content.replace(/\n/g, ' ')}`).join('\n\n')}

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
        // Check for explicit "no matches" responses
        if (result.toLowerCase().includes('no messages match') || 
            result.toLowerCase().includes('none qualify') ||
            result.toLowerCase().trim() === 'none') {
          // All messages have no matches - cache them as empty
          for (const message of chunk) {
            cache.setInterestResult(message.link, [], config.userInterests);
          }
        } else {
          // Parse normal MESSAGE_NUMBER: interests format
          const lines = result.split('\n').filter(line => /^\s*\d+\s*:/.test(line));
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
              cache.setInterestResult(chunk[messageIdx].link, interests, config.userInterests);
              processedMessages.add(messageIdx);
            }
          }
          
          // Cache empty results for unmatched messages
          for (let idx = 0; idx < chunk.length; idx++) {
            if (!processedMessages.has(idx)) {
              cache.setInterestResult(chunk[idx].link, [], config.userInterests);
            }
          }
        }
      } else {
        // No matches in this chunk
        for (const message of chunk) {
          cache.setInterestResult(message.link, [], config.userInterests);
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
    const cachedDateTime = cache.getScheduleResult(message.message.link, config.weeklyTimeslots);
    if (cachedDateTime !== null) {
      cacheHits++;
      if (cachedDateTime !== 'unknown') {
        // Re-validate against current time and schedule
        try {
          const normalizedCachedDateTime = normalizeDateTime(cachedDateTime);
          const eventDate = parse(normalizedCachedDateTime, 'dd MMM yyyy HH:mm', new Date());
          
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
              scheduledMessages.push({
                interesting_message: message,
                start_datetime: normalizedCachedDateTime
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

CRITICAL: Use message timestamps to infer the correct year for events. If an event mentions "March 15" and the message was posted on "March 10, 2024", the event is "March 15, 2024". If a message from "Dec 10, 2023" mentions "Jan 5", the event is "Jan 5, 2024" (next occurrence).

Messages with timestamps:
${chunk.map((msg, idx) => {
  const messageDate = new Date(msg.message.timestamp);
  return `${idx + 1}. [Posted: ${messageDate.toDateString()}] ${msg.message.content.replace(/\n/g, ' ')}`;
}).join('\n\n')}

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
- WRONG: "06 Sep 2025 18"

YEAR INFERENCE RULES:
- If event date is after message date in same year, use same year
- If event date is before message date, use next year (e.g., Dec message mentioning Jan event = next year)
- Always ensure the event date is in the future relative to message timestamp`;

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
          
          // Cache the extracted datetime with proper formatting
          if (messageIdx >= 0 && messageIdx < chunk.length) {
            const normalizedDateTime = normalizeDateTime(dateTime);
            cache.setScheduleResult(chunk[messageIdx].message.link, normalizedDateTime, config.weeklyTimeslots);
            processedMessages.add(messageIdx);
          }
          
          if (messageIdx >= 0 && messageIdx < chunk.length && dateTime !== 'unknown') {
            try {
              // Use normalized date for all processing
              const normalizedDateTime = normalizeDateTime(dateTime);
              const eventDate = parse(normalizedDateTime, 'dd MMM yyyy HH:mm', new Date());
              
              // Check if the date is valid
              if (!isValid(eventDate)) {
                console.log(`    Could not parse date: "${dateTime}" from message: ${chunk[messageIdx].message.link}`);
                continue;
              }
              
              // Validate event date against message timestamp
              const messageDate = new Date(chunk[messageIdx].message.timestamp);
              const now = new Date();
              
              // Check if the event is in the future relative to current time
              if (eventDate <= now) {
                const properDateTime = dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
                console.log(`    ✗ Past event: ${properDateTime} - ${chunk[messageIdx].message.link}`);
                continue;
              }
              
              // Check if event date is reasonable relative to message date (not more than 2 years in the future)
              const maxFutureDate = new Date(messageDate.getTime() + (2 * 365 * 24 * 60 * 60 * 1000)); // 2 years from message
              if (eventDate > maxFutureDate) {
                console.log(`    ✗ Event too far in future: ${normalizedDateTime} (message from ${messageDate.toDateString()}) - ${chunk[messageIdx].message.link}`);
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
                  start_datetime: normalizedDateTime
                });
                
                console.log(`    ✓ Included: ${normalizedDateTime} (day ${dayOfWeek}) - ${chunk[messageIdx].message.link}`);
              } else {
                console.log(`    ✗ Filtered out: ${normalizedDateTime} (day ${dayOfWeek}) - ${chunk[messageIdx].message.link}`);
              }
            } catch (error) {
              console.log(`    Could not parse date: ${dateTime}`);
            }
          }
        }
        
        // Cache 'unknown' for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedMessages.has(idx)) {
            cache.setScheduleResult(chunk[idx].message.link, 'unknown', config.weeklyTimeslots);
          }
        }
      } else {
        // No results from GPT, cache as unknown
        for (const message of chunk) {
          cache.setScheduleResult(message.message.link, 'unknown', config.weeklyTimeslots);
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