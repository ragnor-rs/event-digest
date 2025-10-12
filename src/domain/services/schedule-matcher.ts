import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';

import { Config } from '../../config/types';
import { Cache } from '../../data/cache';
import { OpenAIClient } from '../../data/openai-client';
import { DebugScheduleFilteringEntry } from '../../presentation/debug-writer';
import { createBatches } from '../../shared/batch-processor';
import { normalizeDateTime, MAX_FUTURE_YEARS } from '../../shared/date-utils';
import { Logger } from '../../shared/logger';
import { Event } from '../entities';

export async function filterBySchedule(
  events: Event[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugEntries: DebugScheduleFilteringEntry[],
  logger: Logger
): Promise<Event[]> {
  logger.log(`Filtering ${events.length} events by schedule and availability...`);

  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  // Check cache first
  const uncachedEvents: Event[] = [];
  const scheduledEvents: Event[] = [];
  let cacheHits = 0;

  logger.verbose('  Processing cache...');

  for (const event of events) {
    const cachedDateTime = cache.getScheduledEventCache(event.message.link, config.weeklyTimeslots);
    if (cachedDateTime !== undefined) {
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

            const matchesSchedule = config.weeklyTimeslots.some((slot) => {
              const [slotDay, slotTime] = slot.split(' ');
              const slotDayNum = parseInt(slotDay);
              return slotDayNum === dayOfWeek && timeStr >= slotTime;
            });

            if (matchesSchedule) {
              scheduledEvents.push({
                ...event,
                start_datetime: normalizedCachedDateTime,
              });
              debugEntries.push({
                message: event.message,
                event_type: event.event_type!,
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'scheduled',
                cached: true,
              });
            } else {
              logger.verbose(`    DISCARDED: ${event.message.link} - outside desired timeslots (cached)`);
              debugEntries.push({
                message: event.message,
                event_type: event.event_type!,
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'discarded',
                discard_reason: 'outside desired timeslots',
                cached: true,
              });
            }
          } else {
            logger.verbose(`    DISCARDED: ${event.message.link} - event in the past (cached)`);
            debugEntries.push({
              message: event.message,
              event_type: event.event_type!,
              gpt_prompt: '[CACHED]',
              gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
              extracted_datetime: normalizedCachedDateTime,
              result: 'discarded',
              discard_reason: 'event in the past',
              cached: true,
            });
          }
        } catch (error) {
          logger.verbose(
            `    WARNING: Failed to parse cached datetime "${cachedDateTime}" for ${event.message.link}: ${error instanceof Error ? error.message : String(error)}`
          );
          uncachedEvents.push(event);
        }
      } else {
        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: unknown datetime]',
          extracted_datetime: 'unknown',
          result: 'discarded',
          discard_reason: 'no date/time found',
          cached: true,
        });
      }
    } else {
      uncachedEvents.push(event);
    }
  }

  if (cacheHits > 0) {
    logger.verbose(`  Cache hits: ${cacheHits}/${events.length} messages`);
  }

  if (uncachedEvents.length === 0) {
    logger.verbose(`  All messages cached, skipping GPT calls`);
    logger.log(`  Found ${scheduledEvents.length} messages matching schedule`);
    return scheduledEvents;
  }

  const chunks = createBatches(uncachedEvents, config.gptBatchSizeScheduleExtraction);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.verbose(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const messagesText = chunk
      .map((event, idx) => {
        const messageDate = new Date(event.message.timestamp);
        return `${idx + 1}. [Posted: ${messageDate.toDateString()}] ${event.message.content.replace(/\n/g, ' ')}`;
      })
      .join('\n\n');

    const prompt = config
      .scheduleExtractionPrompt!.replace('{{TODAY_DATE}}', new Date().toDateString())
      .replace('{{MESSAGES}}', messagesText);

    const result = await openaiClient.callWithDelay(prompt);

    if (result) {
      const lines = result.split('\n').filter((line) => line.includes(':'));
      const processedMessages = new Set<number>();

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const numPart = line.substring(0, colonIndex);
        const datePart = line.substring(colonIndex + 1);

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
              logger.verbose(
                `    DISCARDED: ${chunk[messageIdx].message.link} - could not parse date: "${normalizedDateTime}" (original: "${dateTime}")`
              );
              logger.verbose(`    GPT response line: "${line}"`);
              debugEntries.push({
                message: chunk[messageIdx].message,
                event_type: chunk[messageIdx].event_type!,
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: dateTime,
                result: 'discarded',
                discard_reason: 'could not parse date',
                cached: false,
              });
              continue;
            }

            // Validate event date against message timestamp
            const messageDate = new Date(chunk[messageIdx].message.timestamp);
            const now = new Date();

            // Check if the event is in the future relative to current time
            if (eventDate <= now) {
              logger.verbose(`    DISCARDED: ${chunk[messageIdx].message.link} - event in the past`);
              debugEntries.push({
                message: chunk[messageIdx].message,
                event_type: chunk[messageIdx].event_type!,
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: normalizedDateTime,
                result: 'discarded',
                discard_reason: 'event in the past',
                cached: false,
              });
              continue;
            }

            // Check if event date is reasonable relative to message date
            const maxFutureDate = new Date(messageDate.getTime() + MAX_FUTURE_YEARS * 365 * 24 * 60 * 60 * 1000);
            if (eventDate > maxFutureDate) {
              logger.verbose(`    DISCARDED: ${chunk[messageIdx].message.link} - event too far in future`);
              debugEntries.push({
                message: chunk[messageIdx].message,
                event_type: chunk[messageIdx].event_type!,
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: normalizedDateTime,
                result: 'discarded',
                discard_reason: 'event too far in future',
                cached: false,
              });
              continue;
            }

            const dayOfWeek = getDay(eventDate);
            const hour = getHours(eventDate);
            const minute = getMinutes(eventDate);

            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

            const matchesSchedule = config.weeklyTimeslots.some((slot) => {
              const [slotDay, slotTime] = slot.split(' ');
              const slotDayNum = parseInt(slotDay);
              return slotDayNum === dayOfWeek && timeStr >= slotTime;
            });

            if (matchesSchedule) {
              scheduledEvents.push({
                ...chunk[messageIdx],
                start_datetime: normalizedDateTime,
              });
              debugEntries.push({
                message: chunk[messageIdx].message,
                event_type: chunk[messageIdx].event_type!,
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: normalizedDateTime,
                result: 'scheduled',
                cached: false,
              });
            } else {
              logger.verbose(`    DISCARDED: ${chunk[messageIdx].message.link} - outside desired timeslots`);
              debugEntries.push({
                message: chunk[messageIdx].message,
                event_type: chunk[messageIdx].event_type!,
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: normalizedDateTime,
                result: 'discarded',
                discard_reason: 'outside desired timeslots',
                cached: false,
              });
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.verbose(
              `    DISCARDED: ${chunk[messageIdx].message.link} - date parsing error for "${dateTime}" (normalized: "${normalizeDateTime(dateTime)}"): ${errorMsg}`
            );
            debugEntries.push({
              message: chunk[messageIdx].message,
              event_type: chunk[messageIdx].event_type!,
              gpt_prompt: prompt,
              gpt_response: result || '',
              extracted_datetime: dateTime,
              result: 'discarded',
              discard_reason: `date parsing error: ${errorMsg}`,
              cached: false,
            });
          }
        }
      }

      // Cache 'unknown' for unprocessed messages
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedMessages.has(idx)) {
          logger.verbose(`    DISCARDED: ${chunk[idx].message.link} - no date/time found`);
          cache.cacheScheduledEvent(chunk[idx].message.link, 'unknown', config.weeklyTimeslots, false);
          debugEntries.push({
            message: chunk[idx].message,
            event_type: chunk[idx].event_type!,
            gpt_prompt: prompt,
            gpt_response: result || '',
            extracted_datetime: 'unknown',
            result: 'discarded',
            discard_reason: 'no date/time found',
            cached: false,
          });
        }
      }
    } else {
      // No results from GPT, cache as unknown
      for (const event of chunk) {
        logger.verbose(`    DISCARDED: ${event.message.link} - no date/time found`);
        cache.cacheScheduledEvent(event.message.link, 'unknown', config.weeklyTimeslots, false);
        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: prompt,
          gpt_response: result || '[NO RESPONSE]',
          extracted_datetime: 'unknown',
          result: 'discarded',
          discard_reason: 'no date/time found',
          cached: false,
        });
      }
    }

    // Save cache after processing batch
    cache.save();
  }

  logger.log(`  Found ${scheduledEvents.length} messages matching schedule`);
  return scheduledEvents;
}
