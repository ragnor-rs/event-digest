import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';

import { DATETIME_UNKNOWN } from '../constants';
import { Config } from '../../config/types';
import { IAIClient, ICache } from '../interfaces';
import { DebugScheduleFilteringEntry } from '../types';
import { createBatches } from '../../shared/batch-processor';
import { normalizeDateTime, MAX_FUTURE_YEARS, DATE_FORMAT } from '../../shared/date-utils';
import { Logger } from '../../shared/logger';
import { DigestEvent } from '../entities';

/**
 * Validates if an event datetime matches user's availability schedule
 */
function matchesTimeslot(eventDate: Date, weeklyTimeslots: string[]): boolean {
  const dayOfWeek = getDay(eventDate);
  const hour = getHours(eventDate);
  const minute = getMinutes(eventDate);
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

  return weeklyTimeslots.some((slot) => {
    const [slotDay, slotTime] = slot.split(' ');
    const slotDayNum = parseInt(slotDay);
    return slotDayNum === dayOfWeek && timeStr >= slotTime;
  });
}

/**
 * Validates if a datetime is in the future and within reasonable bounds
 */
function isValidEventDateTime(eventDate: Date, messageDate: Date): { valid: boolean; reason?: string } {
  const now = new Date();

  // Check if the event is in the future relative to current time
  if (eventDate <= now) {
    return { valid: false, reason: 'event in the past' };
  }

  // Check if event date is reasonable relative to message date
  const maxFutureDate = new Date(messageDate.getTime() + MAX_FUTURE_YEARS * 365 * 24 * 60 * 60 * 1000);
  if (eventDate > maxFutureDate) {
    return { valid: false, reason: 'event too far in future' };
  }

  return { valid: true };
}

/**
 * Processes a single cached event entry and validates it against current schedule
 */
function processCachedEvent(
  event: DigestEvent,
  cachedDateTime: string,
  config: Config,
  logger: Logger,
  debugEntries: DebugScheduleFilteringEntry[]
): DigestEvent | null {
  try {
    const normalizedCachedDateTime = normalizeDateTime(cachedDateTime);
    const eventDate = parse(normalizedCachedDateTime, DATE_FORMAT, new Date());

    const validation = isValidEventDateTime(eventDate, new Date());
    if (!validation.valid) {
      logger.verbose(`    ✗ Discarded: ${event.message.link} - ${validation.reason} (cached)`);
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: '[CACHED]',
        ai_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
        extracted_datetime: normalizedCachedDateTime,
        result: 'discarded',
        discard_reason: validation.reason,
        cached: true,
      });
      return null;
    }

    if (matchesTimeslot(eventDate, config.weeklyTimeslots)) {
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: '[CACHED]',
        ai_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
        extracted_datetime: normalizedCachedDateTime,
        result: 'scheduled',
        cached: true,
      });
      return { ...event, start_datetime: normalizedCachedDateTime };
    } else {
      logger.verbose(`    ✗ Discarded: ${event.message.link} - outside desired timeslots (cached)`);
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: '[CACHED]',
        ai_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
        extracted_datetime: normalizedCachedDateTime,
        result: 'discarded',
        discard_reason: 'outside desired timeslots',
        cached: true,
      });
      return null;
    }
  } catch (error) {
    logger.verbose(
      `    WARNING: Failed to parse cached datetime "${cachedDateTime}" for ${event.message.link}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null; // Will be reprocessed
  }
}

/**
 * Processes a freshly extracted datetime for an event and validates it
 */
function processExtractedDateTime(
  event: DigestEvent,
  dateTime: string,
  prompt: string,
  result: string,
  config: Config,
  cache: ICache,
  logger: Logger,
  debugEntries: DebugScheduleFilteringEntry[],
  scheduledEvents: DigestEvent[]
): void {
  try {
    // Use normalized date for all processing
    const normalizedDateTime = normalizeDateTime(dateTime);
    const eventDate = parse(normalizedDateTime, DATE_FORMAT, new Date());

    // Check if the date is valid
    if (!isValid(eventDate)) {
      logger.verbose(
        `    ✗ Discarded: ${event.message.link} - could not parse date: "${normalizedDateTime}" (original: "${dateTime}")`
      );
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: prompt,
        ai_response: result || '',
        extracted_datetime: dateTime,
        result: 'discarded',
        discard_reason: 'could not parse date',
        cached: false,
      });
      return;
    }

    // Validate event date
    const messageDate = new Date(event.message.timestamp);
    const validation = isValidEventDateTime(eventDate, messageDate);
    if (!validation.valid) {
      logger.verbose(`    ✗ Discarded: ${event.message.link} - ${validation.reason}`);
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: prompt,
        ai_response: result || '',
        extracted_datetime: normalizedDateTime,
        result: 'discarded',
        discard_reason: validation.reason,
        cached: false,
      });
      return;
    }

    // Check if matches schedule
    if (matchesTimeslot(eventDate, config.weeklyTimeslots)) {
      scheduledEvents.push({
        ...event,
        start_datetime: normalizedDateTime,
      });
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: prompt,
        ai_response: result || '',
        extracted_datetime: normalizedDateTime,
        result: 'scheduled',
        cached: false,
      });
    } else {
      logger.verbose(`    ✗ Discarded: ${event.message.link} - outside desired timeslots`);
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        ai_prompt: prompt,
        ai_response: result || '',
        extracted_datetime: normalizedDateTime,
        result: 'discarded',
        discard_reason: 'outside desired timeslots',
        cached: false,
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.verbose(
      `    ✗ Discarded: ${event.message.link} - date parsing error for "${dateTime}" (normalized: "${normalizeDateTime(dateTime)}"): ${errorMsg}`
    );
    debugEntries.push({
      message: event.message,
      event_type: event.event_type!,
      ai_prompt: prompt,
      ai_response: result || '',
      extracted_datetime: dateTime,
      result: 'discarded',
      discard_reason: `date parsing error: ${errorMsg}`,
      cached: false,
    });
  }
}

export async function filterBySchedule(
  events: DigestEvent[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugScheduleFilteringEntry[],
  logger: Logger
): Promise<DigestEvent[]> {
  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  // Check cache first
  const uncachedEvents: DigestEvent[] = [];
  const scheduledEvents: DigestEvent[] = [];
  let cacheHits = 0;

  logger.verbose('  Processing cache...');

  for (const event of events) {
    const cachedDateTime = cache.getScheduledEventCache(event.message.link, config.weeklyTimeslots);
    if (cachedDateTime !== undefined) {
      cacheHits++;
      if (cachedDateTime !== DATETIME_UNKNOWN) {
        // Re-validate against current time and schedule
        const processedEvent = processCachedEvent(event, cachedDateTime, config, logger, debugEntries);
        if (processedEvent) {
          scheduledEvents.push(processedEvent);
        } else if (!debugEntries.some((e) => e.message.link === event.message.link)) {
          // Failed to parse - will be reprocessed
          uncachedEvents.push(event);
        }
      } else {
        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          ai_prompt: '[CACHED]',
          ai_response: '[CACHED: unknown datetime]',
          extracted_datetime: DATETIME_UNKNOWN,
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
    logger.verbose(`  All messages cached, skipping AI calls`);
    logger.log(`  Found ${scheduledEvents.length} messages matching schedule`);
    return scheduledEvents;
  }

  const chunks = createBatches(uncachedEvents, config.scheduleExtractionBatchSize);

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

    const result = await aiClient.call(prompt);

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

        if (messageIdx >= 0 && messageIdx < chunk.length && dateTime !== DATETIME_UNKNOWN) {
          processExtractedDateTime(
            chunk[messageIdx],
            dateTime,
            prompt,
            result,
            config,
            cache,
            logger,
            debugEntries,
            scheduledEvents
          );
        }
      }

      // Cache 'unknown' for unprocessed messages
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedMessages.has(idx)) {
          logger.verbose(`    ✗ Discarded: ${chunk[idx].message.link} - no date/time found`);
          cache.cacheScheduledEvent(chunk[idx].message.link, DATETIME_UNKNOWN, config.weeklyTimeslots, false);
          debugEntries.push({
            message: chunk[idx].message,
            event_type: chunk[idx].event_type!,
            ai_prompt: prompt,
            ai_response: result || '',
            extracted_datetime: DATETIME_UNKNOWN,
            result: 'discarded',
            discard_reason: 'no date/time found',
            cached: false,
          });
        }
      }
    } else {
      // No results from AI, cache as unknown
      for (const event of chunk) {
        logger.verbose(`    ✗ Discarded: ${event.message.link} - no date/time found`);
        cache.cacheScheduledEvent(event.message.link, DATETIME_UNKNOWN, config.weeklyTimeslots, false);
        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          ai_prompt: prompt,
          ai_response: result || '[NO RESPONSE]',
          extracted_datetime: DATETIME_UNKNOWN,
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
