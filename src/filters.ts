import OpenAI from 'openai';
import { TelegramMessage, EventAnnouncement, InterestingAnnouncement, ScheduledEvent, Config } from './types';
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

export async function filterWithGPT(messages: TelegramMessage[], config: Config): Promise<EventAnnouncement[]> {
  console.log(`Step 3: Using GPT to filter ${messages.length} messages for event announcements...`);
  
  const cache = new Cache();

  // Check cache first
  const uncachedAnnouncements: TelegramMessage[] = [];
  const eventAnnouncements: EventAnnouncement[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedResult = cache.getEventResult(message.link, config.offlineEventsOnly);
    if (cachedResult !== null) {
      cacheHits++;
      if (cachedResult.isEvent && cachedResult.event_type) {
        // Check if cached event should be included based on offline filter
        if (config.offlineEventsOnly && cachedResult.event_type !== 'offline') {
          console.log(`    DISCARDED: ${message.link} [${cachedResult.event_type}] - offline events only (cached)`);
        } else {
          eventAnnouncements.push({
            message,
            event_type: cachedResult.event_type
          });
        }
      }
    } else {
      uncachedAnnouncements.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedAnnouncements.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  GPT identified ${eventAnnouncements.length} event announcements`);
    return eventAnnouncements;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedAnnouncements.length; i += 16) {
    chunks.push(uncachedAnnouncements.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const offlineFilter = config.offlineEventsOnly ? 
      '\n\nADDITIONAL FILTER: Only include OFFLINE events. Exclude any events that are:\n- Virtual, online, or digital-only\n- Webinars, video calls, or livestreams\n- Explicitly mentioned as "online" or "virtual"' : '';

    const prompt = `Analyze these messages and identify which ones are announcements for a SINGLE SPECIFIC EVENT.

CRITICAL: You must EXCLUDE any message that:
- Lists multiple events or contains phrases like "events this week", "upcoming events", "event digest"
- Contains multiple dates or mentions several different activities
- Is a schedule or calendar listing
- Mentions "events" in plural form
- Is a roundup or compilation of events${offlineFilter}

ONLY INCLUDE messages that announce ONE specific event with:
- One specific date/time
- One specific activity/event
- Clear event details (title, location, etc.)

For each qualifying event, classify it as:
- offline: In-person/physical location events
- online: Virtual/digital-only events (webinars, video calls, etc.)
- hybrid: Both in-person and online participation options

Messages:
${chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')}

Respond with each qualifying message number followed by its type, one per line (e.g., "1:offline", "3:hybrid", "7:online"). If none qualify, respond with "none".`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result && result !== 'none') {
        const lines = result.split('\n').filter(line => line.trim());
        const processedIndices = new Set<number>();
        
        for (const line of lines) {
          const match = line.match(/^(\d+):(offline|online|hybrid)$/);
          if (match) {
            const idx = parseInt(match[1]) - 1;
            const eventType = match[2] as 'offline' | 'online' | 'hybrid';
            
            if (idx >= 0 && idx < chunk.length) {
              // Check if event should be included based on offline filter
              if (config.offlineEventsOnly && eventType !== 'offline') {
                console.log(`    DISCARDED: ${chunk[idx].link} [${eventType}] - offline events only`);
              } else {
                eventAnnouncements.push({
                  message: chunk[idx],
                  event_type: eventType
                });
              }
              cache.setEventResult(chunk[idx].link, true, eventType, config.offlineEventsOnly, false);
              processedIndices.add(idx);
            }
          }
        }
        
        // Cache negative results for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedIndices.has(idx)) {
            cache.setEventResult(chunk[idx].link, false, undefined, config.offlineEventsOnly, false);
          }
        }
      } else {
        // All messages in chunk are not events
        for (const message of chunk) {
          cache.setEventResult(message.link, false, undefined, config.offlineEventsOnly, false);
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

  console.log(`  GPT identified ${eventAnnouncements.length} event announcements`);
  return eventAnnouncements;
}

export async function filterByInterests(announcements: EventAnnouncement[], config: Config): Promise<InterestingAnnouncement[]> {
  const cache = new Cache();
  console.log(`Step 4: Filtering ${announcements.length} event announcements by user interests...`);
  
  // Check cache first
  const uncachedAnnouncements: EventAnnouncement[] = [];
  const interestingAnnouncements: InterestingAnnouncement[] = [];
  let cacheHits = 0;

  for (const announcement of announcements) {
    const cachedInterests = cache.getInterestResult(announcement.message.link, config.userInterests);
    if (cachedInterests !== null) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        interestingAnnouncements.push({
          announcement,
          interests_matched: cachedInterests
        });
      } else {
        console.log(`    DISCARDED: ${announcement.message.link} - no interests matched (cached)`);
      }
    } else {
      uncachedAnnouncements.push(announcement);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${announcements.length} messages`);
  }

  if (uncachedAnnouncements.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Found ${interestingAnnouncements.length} messages matching user interests`);
    return interestingAnnouncements;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedAnnouncements.length; i += 16) {
    chunks.push(uncachedAnnouncements.slice(i, i + 16));
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
- ONLY use interests from the exact list provided above - do NOT invent new interests
- If no interests from the list match, do NOT include the message in your response

Messages:
${chunk.map((announcement, idx) => `${idx + 1}. ${announcement.message.content.replace(/\n/g, ' ')}`).join('\n\n')}

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
          // All announcements have no matches - cache them as empty
          for (const announcement of chunk) {
            console.log(`    DISCARDED: ${announcement.message.link} - no interests matched`);
            cache.setInterestResult(announcement.message.link, [], config.userInterests, false);
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
              interestingAnnouncements.push({
                announcement: chunk[messageIdx],
                interests_matched: interests
              });
              cache.setInterestResult(chunk[messageIdx].message.link, interests, config.userInterests, false);
              processedMessages.add(messageIdx);
            }
          }
          
          // Cache empty results for unmatched messages
          for (let idx = 0; idx < chunk.length; idx++) {
            if (!processedMessages.has(idx)) {
              console.log(`    DISCARDED: ${chunk[idx].message.link} - no interests matched`);
              cache.setInterestResult(chunk[idx].message.link, [], config.userInterests, false);
            }
          }
        }
      } else {
        // No matches in this chunk
        for (const announcement of chunk) {
          console.log(`    DISCARDED: ${announcement.message.link} - no interests matched`);
          cache.setInterestResult(announcement.message.link, [], config.userInterests, false);
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

  console.log(`  Found ${interestingAnnouncements.length} messages matching user interests`);
  return interestingAnnouncements;
}

export async function filterBySchedule(announcements: InterestingAnnouncement[], config: Config): Promise<ScheduledEvent[]> {
  const cache = new Cache();
  console.log(`Step 5: Filtering ${announcements.length} event announcements by schedule and future dates...`);
  
  // Check cache first
  const uncachedAnnouncements: InterestingAnnouncement[] = [];
  const scheduledEvents: ScheduledEvent[] = [];
  let cacheHits = 0;

  for (const announcement of announcements) {
    const cachedDateTime = cache.getScheduleResult(announcement.announcement.message.link, config.weeklyTimeslots);
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
              scheduledEvents.push({
                interesting_announcement: announcement,
                start_datetime: normalizedCachedDateTime
              });
            } else {
              console.log(`    DISCARDED: ${announcement.announcement.message.link} - outside desired timeslots (cached)`);
            }
          } else {
            console.log(`    DISCARDED: ${announcement.announcement.message.link} - event in the past (cached)`);
          }
        } catch (error) {
          // If cached data is invalid, re-process
          uncachedAnnouncements.push(announcement);
        }
      }
    } else {
      uncachedAnnouncements.push(announcement);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${announcements.length} messages`);
  }

  if (uncachedAnnouncements.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Found ${scheduledEvents.length} messages matching schedule`);
    return scheduledEvents;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedAnnouncements.length; i += 16) {
    chunks.push(uncachedAnnouncements.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const prompt = `Extract the start date and time for each event. Today's date is ${new Date().toDateString()}.

CRITICAL: Use message timestamps to infer the correct year for events. If an event mentions "March 15" and the message was posted on "March 10, 2024", the event is "March 15, 2024". If a message from "Dec 10, 2023" mentions "Jan 5", the event is "Jan 5, 2024" (next occurrence).

Messages with timestamps:
${chunk.map((announcement, idx) => {
  const messageDate = new Date(announcement.announcement.message.timestamp);
  return `${idx + 1}. [Posted: ${messageDate.toDateString()}] ${announcement.announcement.message.content.replace(/\n/g, ' ')}`;
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
            cache.setScheduleResult(chunk[messageIdx].announcement.message.link, normalizedDateTime, config.weeklyTimeslots, false);
            processedMessages.add(messageIdx);
          }
          
          if (messageIdx >= 0 && messageIdx < chunk.length && dateTime !== 'unknown') {
            try {
              // Use normalized date for all processing
              const normalizedDateTime = normalizeDateTime(dateTime);
              const eventDate = parse(normalizedDateTime, 'dd MMM yyyy HH:mm', new Date());
              
              // Check if the date is valid
              if (!isValid(eventDate)) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - could not parse date`);
                continue;
              }
              
              // Validate event date against message timestamp
              const messageDate = new Date(chunk[messageIdx].announcement.message.timestamp);
              const now = new Date();
              
              // Check if the event is in the future relative to current time
              if (eventDate <= now) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - event in the past`);
                continue;
              }
              
              // Check if event date is reasonable relative to message date (not more than 2 years in the future)
              const maxFutureDate = new Date(messageDate.getTime() + (2 * 365 * 24 * 60 * 60 * 1000)); // 2 years from message
              if (eventDate > maxFutureDate) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - event too far in future`);
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
                scheduledEvents.push({
                  interesting_announcement: chunk[messageIdx],
                  start_datetime: normalizedDateTime
                });
              } else {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - outside desired timeslots`);
              }
            } catch (error) {
              console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - date parsing error`);
            }
          }
        }
        
        // Cache 'unknown' for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedMessages.has(idx)) {
            console.log(`    DISCARDED: ${chunk[idx].announcement.message.link} - no date/time found`);
            cache.setScheduleResult(chunk[idx].announcement.message.link, 'unknown', config.weeklyTimeslots, false);
          }
        }
      } else {
        // No results from GPT, cache as unknown
        for (const announcement of chunk) {
          console.log(`    DISCARDED: ${announcement.announcement.message.link} - no date/time found`);
          cache.setScheduleResult(announcement.announcement.message.link, 'unknown', config.weeklyTimeslots, false);
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

  console.log(`  Found ${scheduledEvents.length} messages matching schedule`);
  return scheduledEvents;
}