import OpenAI from 'openai';
import { TelegramMessage, Event, Config } from './types';
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

export async function detectEventAnnouncements(messages: TelegramMessage[], config: Config): Promise<Event[]> {
  console.log(`Step 3: Using GPT to detect event announcements from ${messages.length} messages...`);

  if (messages.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  if (config.verboseLogging) {
    console.log(`  Processing cache...`);
  }
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
  const events: Event[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedResult = cache.isEventMessageCached(message.link);
    if (cachedResult !== null) {
      cacheHits++;
      if (cachedResult) {
        events.push({ message });
        debugResults.push({
          messageLink: message.link,
          isEvent: true,
          cached: true,
        });
      } else {
        if (config.verboseLogging) {
          console.log(`    DISCARDED: ${message.link} - not an event announcement (cached)`);
        }
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

  if (config.verboseLogging && cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    if (config.verboseLogging) {
      console.log(`  All messages cached, skipping GPT calls`);
    }
    console.log(`  GPT identified ${events.length} event messages`);

    if (config.writeDebugFiles) {
      debugWriter.writeEventDetection(debugResults);
    }

    return events;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += config.gptBatchSizeEventDetection) {
    chunks.push(uncachedMessages.slice(i, i + config.gptBatchSizeEventDetection));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    // No offline filtering at this step

    const prompt = config.eventDetectionPrompt!.replace(
      '{{MESSAGES}}',
      chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')
    );

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
              events.push({ message: chunk[idx] });
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
            if (config.verboseLogging) {
              console.log(`    DISCARDED: ${chunk[idx].link} - not an event announcement`);
            }
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
          if (config.verboseLogging) {
            console.log(`    DISCARDED: ${message.link} - not an event announcement`);
          }
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

  console.log(`  GPT identified ${events.length} event messages`);

  if (config.writeDebugFiles) {
    debugWriter.writeEventDetection(debugResults);
  }

  return events;
}

export async function classifyEventTypes(events: Event[], config: Config): Promise<Event[]> {
  console.log(`Step 4: Classifying event types for ${events.length} events...`);

  if (events.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  const cache = new Cache();
  const classifiedEvents: Event[] = [];
  const uncachedEvents: Event[] = [];
  let cacheHits = 0;

  if (config.verboseLogging) {
    console.log('  Processing cache...');
  }
  for (const event of events) {
    const cachedType = cache.getEventTypeCache(event.message.link);
    if (cachedType !== null) {
      cacheHits++;

      // Check if we should include this event based on skipOnlineEvents
      if (cachedType === 'online' && config.skipOnlineEvents) {
        if (config.verboseLogging) {
          console.log(`    DISCARDED: ${event.message.link} [${cachedType}] - skipping online events (cached)`);
        }
        debugWriter.addStep4Entry({
          message: event.message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: 'discarded',
          substep: '4_classification',
          cached: true
        });
      } else {
        classifiedEvents.push({
          ...event,
          event_type: cachedType
        });
        debugWriter.addStep4Entry({
          message: event.message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: cachedType,
          substep: '4_classification',
          cached: true
        });
      }
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
    console.log(`  Created ${classifiedEvents.length} classified events`);
    return classifiedEvents;
  }

  const chunks = [];
  for (let i = 0; i < uncachedEvents.length; i += config.gptBatchSizeEventClassification) {
    chunks.push(uncachedEvents.slice(i, i + config.gptBatchSizeEventClassification));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (config.verboseLogging) {
      console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);
    }

    const messagesText = chunk.map((event, idx) => `${idx + 1}. ${event.message.content.replace(/\n/g, ' ')}`).join('\n\n');
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
              cache.cacheEventType(chunk[messageIdx].message.link, eventType, false);
              processedIndices.add(messageIdx);

              // Check if we should include this event
              if (eventType === 'online' && config.skipOnlineEvents) {
                if (config.verboseLogging) {
                  console.log(`    DISCARDED: ${chunk[messageIdx].message.link} [${eventType}] - skipping online events`);
                }
                debugWriter.addStep4Entry({
                  message: chunk[messageIdx].message,
                  gpt_prompt: prompt,
                  gpt_response: result,
                  result: 'discarded',
                  substep: '4_classification',
                  cached: false
                });
              } else {
                classifiedEvents.push({
                  ...chunk[messageIdx],
                  event_type: eventType
                });
                debugWriter.addStep4Entry({
                  message: chunk[messageIdx].message,
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

      // Handle unprocessed events (shouldn't happen, but just in case)
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedIndices.has(idx)) {
          if (config.verboseLogging) {
            console.log(`    WARNING: ${chunk[idx].message.link} - no classification received, defaulting to offline`);
          }
          const eventType = 'offline';
          cache.cacheEventType(chunk[idx].message.link, eventType, false);
          classifiedEvents.push({
            ...chunk[idx],
            event_type: eventType
          });
          debugWriter.addStep4Entry({
            message: chunk[idx].message,
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
      for (const event of chunk) {
        classifiedEvents.push({
          ...event,
          event_type: 'offline'
        });
      }
    }

    cache.save();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Created ${classifiedEvents.length} classified events`);
  return classifiedEvents;
}

export async function filterByInterests(events: Event[], config: Config): Promise<Event[]> {
  console.log(`Step 6: Filtering ${events.length} events by user interests...`);
  
  if (events.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }
  
  const cache = new Cache();
  
  // Check cache first
  const uncachedEvents: Event[] = [];
  const matchedEvents: Event[] = [];
  let cacheHits = 0;

  if (config.verboseLogging) {
    console.log('  Processing cache...');
  }
  for (const event of events) {
    const cachedInterests = cache.getMatchingInterestsCache(event.message.link, config.userInterests);
    if (cachedInterests !== null) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        matchedEvents.push({
          ...event,
          interests_matched: cachedInterests
        });
        debugWriter.addStep6Entry({
          start_datetime: event.start_datetime!,
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: matched interests: ${cachedInterests.join(', ')}]`,
          interests_matched: cachedInterests,
          result: 'matched',
          cached: true
        });
      } else {
        if (config.verboseLogging) {
          console.log(`    DISCARDED: ${event.message.link} - no interests matched (cached)`);
        }
        debugWriter.addStep6Entry({
          start_datetime: event.start_datetime!,
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: no interests matched]',
          interests_matched: [],
          result: 'discarded',
          cached: true
        });
      }
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
    console.log(`  Found ${matchedEvents.length} events matching user interests`);
    return matchedEvents;
  }

  // Process each event individually
  for (let i = 0; i < uncachedEvents.length; i++) {
    const event: Event = uncachedEvents[i];
    if (config.verboseLogging) {
      console.log(`  Processing event ${i + 1}/${uncachedEvents.length}...`);
    }

    const eventsText = `0: ${event.message.content.replace(/\n/g, ' ')}`;

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

      if (!result) {
        // GPT returned undefined/empty - technical issue
        if (config.verboseLogging) {
          console.log(`    DISCARDED: ${event.message.link} - GPT returned no response`);
        }
        cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
        debugWriter.addStep6Entry({
          start_datetime: event.start_datetime!,
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: prompt,
          gpt_response: '[NO RESPONSE - EMPTY]',
          interests_matched: [],
          result: 'discarded',
          cached: false
        });
      } else if (result.toLowerCase() === 'none') {
        // GPT explicitly said "none" - legitimate no match
        if (config.verboseLogging) {
          console.log(`    DISCARDED: ${event.message.link} - GPT returned "none"`);
        }
        cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
        debugWriter.addStep6Entry({
          message: event.message,
          event_type: event.event_type!,
          start_datetime: event.start_datetime!,
          gpt_prompt: prompt,
          gpt_response: 'none',
          interests_matched: [],
          result: 'discarded',
          cached: false
        });
      } else {
        // GPT returned interest indices
        const interestIndices: number[] = result
          .split(',')
          .map((s: string) => parseInt(s.trim()))
          .filter((idx: number) => !isNaN(idx));

        // Convert indices to interest names
        const matchedInterests: string[] = interestIndices
          .filter((idx: number) => idx >= 0 && idx < config.userInterests.length)
          .map((idx: number) => config.userInterests[idx]);

        // Warn about invalid indices
        const invalidIndices: number[] = interestIndices.filter(
          (idx: number) => idx < 0 || idx >= config.userInterests.length
        );
        if (config.verboseLogging && invalidIndices.length > 0) {
          console.log(`    WARNING: GPT returned invalid interest indices: ${invalidIndices.join(', ')}`);
        }

        if (matchedInterests.length > 0) {
          matchedEvents.push({
            ...event,
            interests_matched: matchedInterests
          });
          cache.cacheMatchingInterests(event.message.link, matchedInterests, config.userInterests, false);

          debugWriter.addStep6Entry({
            message: event.message,
            event_type: event.event_type!,
            start_datetime: event.start_datetime!,
            gpt_prompt: prompt,
            gpt_response: result,
            interests_matched: matchedInterests,
            result: 'matched',
            cached: false
          });
        } else {
          // Parsed result but no valid interests (all invalid indices or empty)
          if (config.verboseLogging) {
            console.log(`    DISCARDED: ${event.message.link} - no valid interests parsed from response`);
          }
          cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
          debugWriter.addStep6Entry({
            message: event.message,
            event_type: event.event_type!,
            start_datetime: event.start_datetime!,
            gpt_prompt: prompt,
            gpt_response: result,
            interests_matched: [],
            result: 'discarded',
            cached: false
          });
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }

    // Save cache after processing each event
    cache.save();

    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Found ${matchedEvents.length} events matching user interests`);

  return matchedEvents;
}

export async function filterBySchedule(events: Event[], config: Config): Promise<Event[]> {
  console.log(`Step 5: Filtering ${events.length} event announcements by schedule and future dates...`);

  if (events.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  const cache = new Cache();

  // Check cache first
  const uncachedEvents: Event[] = [];
  const scheduledEvents: Event[] = [];
  let cacheHits = 0;

  if (config.verboseLogging) {
    console.log('  Processing cache...');
  }
  for (const event of events) {
    const cachedDateTime = cache.getScheduledEventCache(event.message.link, config.weeklyTimeslots);
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
                ...event,
                start_datetime: normalizedCachedDateTime
              });
              debugWriter.addStep5Entry({
                message: event.message,
                event_type: event.event_type!,
                
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'scheduled',
                cached: true
              });
            } else {
              if (config.verboseLogging) {
                console.log(`    DISCARDED: ${event.message.link} - outside desired timeslots (cached)`);
              }
              debugWriter.addStep5Entry({
                message: event.message,
                event_type: event.event_type!,
                
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'discarded',
                discard_reason: 'outside desired timeslots',
                cached: true
              });
            }
          } else {
            if (config.verboseLogging) {
              console.log(`    DISCARDED: ${event.message.link} - event in the past (cached)`);
            }
            debugWriter.addStep5Entry({
              message: event.message,
              event_type: event.event_type!,
              
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
          uncachedEvents.push(event);
        }
      } else {
        debugWriter.addStep5Entry({
          message: event.message,
          event_type: event.event_type!,
          
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: unknown datetime]',
          extracted_datetime: 'unknown',
          result: 'discarded',
          discard_reason: 'no date/time found',
          cached: true
        });
      }
    } else {
      uncachedEvents.push(event);
    }
  }

  if (config.verboseLogging && cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${events.length} messages`);
  }

  if (uncachedEvents.length === 0) {
    if (config.verboseLogging) {
      console.log(`  All messages cached, skipping GPT calls`);
    }
    console.log(`  Found ${scheduledEvents.length} messages matching schedule`);
    return scheduledEvents;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedEvents.length; i += config.gptBatchSizeScheduleExtraction) {
    chunks.push(uncachedEvents.slice(i, i + config.gptBatchSizeScheduleExtraction));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (config.verboseLogging) {
      console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    }

    const messagesText = chunk.map((event, idx) => {
      const messageDate = new Date(event.message.timestamp);
      return `${idx + 1}. [Posted: ${messageDate.toDateString()}] ${event.message.content.replace(/\n/g, ' ')}`;
    }).join('\n\n');

    const prompt = config.scheduleExtractionPrompt!
      .replace('{{TODAY_DATE}}', new Date().toDateString())
      .replace('{{MESSAGES}}', messagesText);

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
            cache.cacheScheduledEvent(chunk[messageIdx].message.link, normalizedDateTime, config.weeklyTimeslots, false);
            processedMessages.add(messageIdx);
          }

          if (messageIdx >= 0 && messageIdx < chunk.length && dateTime !== 'unknown') {
            try {
              // Use normalized date for all processing
              const normalizedDateTime = normalizeDateTime(dateTime);
              const eventDate = parse(normalizedDateTime, 'dd MMM yyyy HH:mm', new Date());

              // Check if the date is valid
              if (!isValid(eventDate)) {
                if (config.verboseLogging) {
                  console.log(`    DISCARDED: ${chunk[messageIdx].message.link} - could not parse date`);
                }
                debugWriter.addStep5Entry({
                  message: chunk[messageIdx].message,
                  event_type: chunk[messageIdx].event_type!,
                  
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
              const messageDate = new Date(chunk[messageIdx].message.timestamp);
              const now = new Date();

              // Check if the event is in the future relative to current time
              if (eventDate <= now) {
                if (config.verboseLogging) {
                  console.log(`    DISCARDED: ${chunk[messageIdx].message.link} - event in the past`);
                }
                debugWriter.addStep5Entry({
                  message: chunk[messageIdx].message,
                  event_type: chunk[messageIdx].event_type!,
                  
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
                if (config.verboseLogging) {
                  console.log(`    DISCARDED: ${chunk[messageIdx].message.link} - event too far in future`);
                }
                debugWriter.addStep5Entry({
                  message: chunk[messageIdx].message,
                  event_type: chunk[messageIdx].event_type!,
                  
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
                  ...chunk[messageIdx],
                  start_datetime: normalizedDateTime
                });
                debugWriter.addStep5Entry({
                  message: chunk[messageIdx].message,
                  event_type: chunk[messageIdx].event_type!,
                  
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'scheduled',
                  cached: false
                });
              } else {
                if (config.verboseLogging) {
                  console.log(`    DISCARDED: ${chunk[messageIdx].message.link} - outside desired timeslots`);
                }
                debugWriter.addStep5Entry({
                  message: chunk[messageIdx].message,
                  event_type: chunk[messageIdx].event_type!,
                  
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'outside desired timeslots',
                  cached: false
                });
              }
            } catch (error) {
              if (config.verboseLogging) {
                console.log(`    DISCARDED: ${chunk[messageIdx].message.link} - date parsing error`);
              }
              debugWriter.addStep5Entry({
                message: chunk[messageIdx].message,
                event_type: chunk[messageIdx].event_type!,
                
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
            if (config.verboseLogging) {
              console.log(`    DISCARDED: ${chunk[idx].message.link} - no date/time found`);
            }
            cache.cacheScheduledEvent(chunk[idx].message.link, 'unknown', config.weeklyTimeslots, false);
            debugWriter.addStep5Entry({
              message: chunk[idx].message,
              event_type: chunk[idx].event_type!,
              
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
        for (const event of chunk) {
          if (config.verboseLogging) {
            console.log(`    DISCARDED: ${event.message.link} - no date/time found`);
          }
          cache.cacheScheduledEvent(event.message.link, 'unknown', config.weeklyTimeslots, false);
          debugWriter.addStep5Entry({
            message: event.message,
            event_type: event.event_type!,
            
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