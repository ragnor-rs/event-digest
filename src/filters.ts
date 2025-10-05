import OpenAI from 'openai';
import { TelegramMessage, EventAnnouncement, InterestingAnnouncement, ScheduledEvent, Config } from './types';
import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';
import { Cache } from './cache';
import { debugWriter } from './debug';

// Single source of truth for date normalization
function normalizeDateTime(dateTime: string): string {
  if (dateTime === 'unknown') return dateTime;
  // Fix incomplete format: "06 Sep 2025 18" → "06 Sep 2025 18:00"
  return dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function filterByEventCues(messages: TelegramMessage[], config: Config): Promise<TelegramMessage[]> {
  console.log(`Step 2: Filtering ${messages.length} messages by event cues...`);

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

export async function detectEventAnnouncements(messages: TelegramMessage[], config: Config): Promise<TelegramMessage[]> {
  console.log(`Step 3: Using GPT to detect event announcements from ${messages.length} messages...`);

  if (messages.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  console.log(`  Processing cache...`);
  const cache = new Cache();
  const debugResults: Array<{
    messageLink: string;
    isEvent: boolean;
    cached: boolean;
    prompt?: string;
    gptResponse?: string;
  }> = [];

  // Check cache first
  const uncachedMessages: TelegramMessage[] = [];
  const eventMessages: TelegramMessage[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedResult = cache.isEventMessageCached(message.link);
    if (cachedResult !== null) {
      cacheHits++;
      if (cachedResult) {
        eventMessages.push(message);
        debugResults.push({
          messageLink: message.link,
          isEvent: true,
          cached: true,
        });
      } else {
        console.log(`    DISCARDED: ${message.link} - not an event announcement (cached)`);
        debugResults.push({
          messageLink: message.link,
          isEvent: false,
          cached: true,
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
    console.log(`  GPT identified ${eventMessages.length} event messages`);

    if (config.writeDebugFiles) {
      debugWriter.writeEventDetection(debugResults);
    }

    return eventMessages;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    // No offline filtering at this step

    const prompt = `Analyze these messages and identify which ones are announcements for a SINGLE SPECIFIC EVENT.

An event announcement should include:
- A specific date/time (can be relative like "сегодня/today", "завтра/tomorrow", specific times like "19:30", or absolute dates)
- A specific activity, meetup, workshop, presentation, talk, or gathering
- Details about what will happen (even if brief)

INCLUDE messages that:
- Announce workshops, meetups, presentations, talks, networking events, webinars, broadcasts
- Have clear timing information (specific time, date, or relative dates)  
- Describe a specific gathering or activity (online or offline)
- Invite people to participate, attend, or join something specific
- Contain meeting links (Zoom, Google Meet, etc.) with scheduled times
- Use words like "приходите/come", "присоединяйтесь/join", "встреча/meeting", "событие/event", "вещать/broadcast"
- Ask people to set calendar reminders or save dates
- Provide specific times with timezone information (МСК, GMT, etc.)

EXCLUDE only messages that:
- Are clearly event digests/roundups listing multiple different events
- Are general announcements without specific timing or scheduling
- Are purely informational posts without inviting participation
- Are job postings, news articles, or promotional content without events

IMPORTANT: Look for timing indicators in ANY language:
- Russian: сегодня, завтра, время, встреча, МСК, вещать
- English: today, tomorrow, time, meeting, at X:XX, broadcast
- Numbers indicating time: 19:30, 14:00, etc.
- Calendar references: "ставьте в календарь", "set reminder", "save the date"

EXAMPLE of what should be INCLUDED:
- A message saying "Today at 19:30 MSK I will broadcast about LinkedIn" with a Zoom link → This IS an event
- A message with "сегодня вещать" + time + meeting link → This IS an event

Messages:
${chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')}

CRITICAL: Respond with each qualifying message number, one per line (e.g., "1", "3", "7"). If none qualify, respond with "none".`;

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
          const match = line.trim().match(/^(\d+)$/);
          if (match) {
            const idx = parseInt(match[1]) - 1;

            if (idx >= 0 && idx < chunk.length) {
              eventMessages.push(chunk[idx]);
              cache.cacheEventMessage(chunk[idx].link, true, false);
              processedIndices.add(idx);

              debugResults.push({
                messageLink: chunk[idx].link,
                isEvent: true,
                cached: false,
                prompt,
                gptResponse: result,
              });
            }
          }
        }

        // Cache negative results for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedIndices.has(idx)) {
            console.log(`    DISCARDED: ${chunk[idx].link} - not an event announcement`);
            cache.cacheEventMessage(chunk[idx].link, false, false);

            debugResults.push({
              messageLink: chunk[idx].link,
              isEvent: false,
              cached: false,
              prompt,
              gptResponse: result,
            });
          }
        }
      } else {
        // All messages in chunk are not events
        for (const message of chunk) {
          console.log(`    DISCARDED: ${message.link} - not an event announcement`);
          cache.cacheEventMessage(message.link, false, false);

          debugResults.push({
            messageLink: message.link,
            isEvent: false,
            cached: false,
            prompt,
            gptResponse: result || 'none',
          });
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

  console.log(`  GPT identified ${eventMessages.length} event messages`);

  if (config.writeDebugFiles) {
    debugWriter.writeEventDetection(debugResults);
  }

  return eventMessages;
}

export async function classifyEventTypes(messages: TelegramMessage[], config: Config): Promise<EventAnnouncement[]> {
  console.log(`Step 4: Classifying event types for ${messages.length} messages...`);

  if (messages.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  const cache = new Cache();
  const eventAnnouncements: EventAnnouncement[] = [];
  const uncachedMessages: TelegramMessage[] = [];
  let cacheHits = 0;

  console.log('  Processing cache...');
  for (const message of messages) {
    const cachedType = cache.getEventTypeCache(message.link);
    if (cachedType !== null) {
      cacheHits++;

      // Check if we should include this event based on skipOnlineEvents
      if (cachedType === 'online' && config.skipOnlineEvents) {
        console.log(`    DISCARDED: ${message.link} [${cachedType}] - skipping online events (cached)`);
        debugWriter.addStep4Entry({
          message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: 'discarded',
          substep: '4_classification',
          cached: true
        });
      } else {
        eventAnnouncements.push({
          message,
          event_type: cachedType
        });
        debugWriter.addStep4Entry({
          message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: cachedType,
          substep: '4_classification',
          cached: true
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
    console.log(`  Created ${eventAnnouncements.length} event announcements`);
    return eventAnnouncements;
  }

  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const messagesText = chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n');
    const prompt = (config.eventTypeClassificationPrompt || '').replace('{{MESSAGES}}', messagesText);

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      const processedIndices = new Set<number>();

      if (result) {
        const lines = result.split('\n').filter(line => line.trim());

        for (const line of lines) {
          const match = line.trim().match(/^(\d+)\s*:\s*(\d+)$/);
          if (match) {
            const messageIdx = parseInt(match[1]) - 1;
            const classificationIdx = parseInt(match[2]);

            if (messageIdx >= 0 && messageIdx < chunk.length && classificationIdx >= 0 && classificationIdx <= 2) {
              const eventType = classificationIdx === 0 ? 'offline' : classificationIdx === 1 ? 'online' : 'hybrid';

              // Cache the result
              cache.cacheEventType(chunk[messageIdx].link, eventType, false);
              processedIndices.add(messageIdx);

              // Check if we should include this event
              if (eventType === 'online' && config.skipOnlineEvents) {
                console.log(`    DISCARDED: ${chunk[messageIdx].link} [${eventType}] - skipping online events`);
                debugWriter.addStep4Entry({
                  message: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result,
                  result: 'discarded',
                  substep: '4_classification',
                  cached: false
                });
              } else {
                eventAnnouncements.push({
                  message: chunk[messageIdx],
                  event_type: eventType
                });
                debugWriter.addStep4Entry({
                  message: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result,
                  result: eventType,
                  substep: '4_classification',
                  cached: false
                });
              }
            }
          }
        }
      }

      // Handle unprocessed messages (shouldn't happen, but just in case)
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedIndices.has(idx)) {
          console.log(`    WARNING: ${chunk[idx].link} - no classification received, defaulting to offline`);
          const eventType = 'offline';
          cache.cacheEventType(chunk[idx].link, eventType, false);
          eventAnnouncements.push({
            message: chunk[idx],
            event_type: eventType
          });
          debugWriter.addStep4Entry({
            message: chunk[idx],
            gpt_prompt: prompt,
            gpt_response: result || '[NO RESPONSE]',
            result: eventType,
            substep: '4_classification',
            cached: false
          });
        }
      }
    } catch (error) {
      console.error('Error with OpenAI event classification:', error);
      // On error, add all as offline events
      for (const message of chunk) {
        eventAnnouncements.push({
          message,
          event_type: 'offline'
        });
      }
    }

    cache.save();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Created ${eventAnnouncements.length} event announcements`);
  return eventAnnouncements;
}

export async function filterByInterests(announcements: EventAnnouncement[], config: Config): Promise<InterestingAnnouncement[]> {
  console.log(`Step 5: Filtering ${announcements.length} event announcements by user interests...`);
  
  if (announcements.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }
  
  const cache = new Cache();
  
  // Check cache first
  const uncachedAnnouncements: EventAnnouncement[] = [];
  const interestingAnnouncements: InterestingAnnouncement[] = [];
  let cacheHits = 0;

  console.log('  Processing cache...');
  for (const announcement of announcements) {
    const cachedInterests = cache.getMatchingInterestsCache(announcement.message.link, config.userInterests);
    if (cachedInterests !== null) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        interestingAnnouncements.push({
          announcement,
          interests_matched: cachedInterests
        });
        debugWriter.addStep5Entry({
          announcement,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: matched interests: ${cachedInterests.join(', ')}]`,
          interests_matched: cachedInterests,
          result: 'matched',
          cached: true
        });
      } else {
        console.log(`    DISCARDED: ${announcement.message.link} - no interests matched (cached)`);
        debugWriter.addStep5Entry({
          announcement,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: no interests matched]',
          interests_matched: [],
          result: 'discarded',
          cached: true
        });
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
  
  const chunks: EventAnnouncement[][] = [];
  for (let i = 0; i < uncachedAnnouncements.length; i += 16) {
    chunks.push(uncachedAnnouncements.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk: EventAnnouncement[] = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const eventsText = chunk.map((announcement: EventAnnouncement, idx: number) =>
      `${idx}: ${announcement.message.content.replace(/\n/g, ' ')}`
    ).join('\n');

    const interestsText = config.userInterests.map((interest: string, idx: number) =>
      `${idx}: ${interest}`
    ).join('\n');

    const prompt: string = (config.interestMatchingPrompt || '')
      .replace('{{EVENTS}}', eventsText)
      .replace('{{INTERESTS}}', interestsText);

    try {
      const response: any = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result: string | undefined = response.choices[0].message.content?.trim();
      const processedMessages = new Set<number>();

      if (result) {
        // Parse EVENT_INDEX: INTEREST_INDEX1, INTEREST_INDEX2, ... format
        const lines: string[] = result.split('\n').filter((line: string) => /^\s*\d+\s*:/.test(line));

        for (const line of lines) {
          const match = line.match(/^(\d+)\s*:\s*(.*)$/);
          if (match) {
            const eventIdx: number = parseInt(match[1]);
            const indicesPart: string = match[2].trim();

            if (eventIdx >= 0 && eventIdx < chunk.length) {
              // Parse interest indices
              const interestIndices: number[] = indicesPart
                ? indicesPart.split(',').map((s: string) => parseInt(s.trim())).filter((idx: number) => !isNaN(idx))
                : [];

              // Convert indices to interest names
              const matchedInterests: string[] = interestIndices
                .filter((idx: number) => idx >= 0 && idx < config.userInterests.length)
                .map((idx: number) => config.userInterests[idx]);

              // Warn about invalid indices
              const invalidIndices: number[] = interestIndices.filter(
                (idx: number) => idx < 0 || idx >= config.userInterests.length
              );
              if (invalidIndices.length > 0) {
                console.log(`    WARNING: GPT returned invalid interest indices for event ${eventIdx}: ${invalidIndices.join(', ')}`);
              }

              if (matchedInterests.length > 0) {
                interestingAnnouncements.push({
                  announcement: chunk[eventIdx],
                  interests_matched: matchedInterests
                });
                cache.cacheMatchingInterests(chunk[eventIdx].message.link, matchedInterests, config.userInterests, false);
                processedMessages.add(eventIdx);

                debugWriter.addStep5Entry({
                  announcement: chunk[eventIdx],
                  gpt_prompt: prompt,
                  gpt_response: result,
                  interests_matched: matchedInterests,
                  result: 'matched',
                  cached: false
                });
              } else {
                // Empty interest list for this event
                processedMessages.add(eventIdx);
                console.log(`    DISCARDED: ${chunk[eventIdx].message.link} - no interests matched`);
                cache.cacheMatchingInterests(chunk[eventIdx].message.link, [], config.userInterests, false);
                debugWriter.addStep5Entry({
                  announcement: chunk[eventIdx],
                  gpt_prompt: prompt,
                  gpt_response: result,
                  interests_matched: [],
                  result: 'discarded',
                  cached: false
                });
              }
            }
          }
        }
      }

      // Cache empty results for unprocessed events
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedMessages.has(idx)) {
          console.log(`    DISCARDED: ${chunk[idx].message.link} - no interests matched`);
          cache.cacheMatchingInterests(chunk[idx].message.link, [], config.userInterests, false);
          debugWriter.addStep5Entry({
            announcement: chunk[idx],
            gpt_prompt: prompt,
            gpt_response: result || '[NO RESPONSE]',
            interests_matched: [],
            result: 'discarded',
            cached: false
          });
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
  console.log(`Step 6: Filtering ${announcements.length} event announcements by schedule and future dates...`);
  
  if (announcements.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }
  
  const cache = new Cache();
  
  // Check cache first
  const uncachedAnnouncements: InterestingAnnouncement[] = [];
  const scheduledEvents: ScheduledEvent[] = [];
  let cacheHits = 0;

  console.log('  Processing cache...');
  for (const announcement of announcements) {
    const cachedDateTime = cache.getScheduledEventCache(announcement.announcement.message.link, config.weeklyTimeslots);
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
              debugWriter.addStep6Entry({
                announcement,
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'scheduled',
                cached: true
              });
            } else {
              console.log(`    DISCARDED: ${announcement.announcement.message.link} - outside desired timeslots (cached)`);
              debugWriter.addStep6Entry({
                announcement,
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'discarded',
                discard_reason: 'outside desired timeslots',
                cached: true
              });
            }
          } else {
            console.log(`    DISCARDED: ${announcement.announcement.message.link} - event in the past (cached)`);
            debugWriter.addStep6Entry({
              announcement,
              gpt_prompt: '[CACHED]',
              gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
              extracted_datetime: normalizedCachedDateTime,
              result: 'discarded',
              discard_reason: 'event in the past',
              cached: true
            });
          }
        } catch (error) {
          // If cached data is invalid, re-process
          uncachedAnnouncements.push(announcement);
        }
      } else {
        debugWriter.addStep6Entry({
          announcement,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: unknown datetime]',
          extracted_datetime: 'unknown',
          result: 'discarded',
          discard_reason: 'no date/time found',
          cached: true
        });
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
            cache.cacheScheduledEvent(chunk[messageIdx].announcement.message.link, normalizedDateTime, config.weeklyTimeslots, false);
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
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: dateTime,
                  result: 'discarded',
                  discard_reason: 'could not parse date',
                  cached: false
                });
                continue;
              }
              
              // Validate event date against message timestamp
              const messageDate = new Date(chunk[messageIdx].announcement.message.timestamp);
              const now = new Date();
              
              // Check if the event is in the future relative to current time
              if (eventDate <= now) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - event in the past`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'event in the past',
                  cached: false
                });
                continue;
              }
              
              // Check if event date is reasonable relative to message date (not more than 2 years in the future)
              const maxFutureDate = new Date(messageDate.getTime() + (2 * 365 * 24 * 60 * 60 * 1000)); // 2 years from message
              if (eventDate > maxFutureDate) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - event too far in future`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'event too far in future',
                  cached: false
                });
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
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'scheduled',
                  cached: false
                });
              } else {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - outside desired timeslots`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'outside desired timeslots',
                  cached: false
                });
              }
            } catch (error) {
              console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - date parsing error`);
              debugWriter.addStep6Entry({
                announcement: chunk[messageIdx],
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: dateTime,
                result: 'discarded',
                discard_reason: 'date parsing error',
                cached: false
              });
            }
          }
        }
        
        // Cache 'unknown' for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedMessages.has(idx)) {
            console.log(`    DISCARDED: ${chunk[idx].announcement.message.link} - no date/time found`);
            cache.cacheScheduledEvent(chunk[idx].announcement.message.link, 'unknown', config.weeklyTimeslots, false);
            debugWriter.addStep6Entry({
              announcement: chunk[idx],
              gpt_prompt: prompt,
              gpt_response: result || '',
              extracted_datetime: 'unknown',
              result: 'discarded',
              discard_reason: 'no date/time found',
              cached: false
            });
          }
        }
      } else {
        // No results from GPT, cache as unknown
        for (const announcement of chunk) {
          console.log(`    DISCARDED: ${announcement.announcement.message.link} - no date/time found`);
          cache.cacheScheduledEvent(announcement.announcement.message.link, 'unknown', config.weeklyTimeslots, false);
          debugWriter.addStep6Entry({
            announcement,
            gpt_prompt: prompt,
            gpt_response: result || '[NO RESPONSE]',
            extracted_datetime: 'unknown',
            result: 'discarded',
            discard_reason: 'no date/time found',
            cached: false
          });
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