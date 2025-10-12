import { Config } from '../../config/types';
import { Cache } from '../../data/cache';
import { OpenAIClient } from '../../data/openai-client';
import { DebugTypeClassificationEntry } from '../../presentation/debug-writer';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { Event, EventType } from '../entities';

export async function classifyEventTypes(
  events: Event[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugEntries: DebugTypeClassificationEntry[],
  logger: Logger
): Promise<Event[]> {
  logger.log(`Classifying event types for ${events.length} events...`);

  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  const classifiedEvents: Event[] = [];
  const uncachedEvents: Event[] = [];
  let cacheHits = 0;

  logger.verbose('  Processing cache...');

  for (const event of events) {
    const cachedType = cache.getEventTypeCache(event.message.link);
    if (cachedType !== undefined) {
      cacheHits++;

      // Check if we should include this event based on skipOnlineEvents
      if (cachedType === EventType.ONLINE && config.skipOnlineEvents) {
        logger.verbose(`    DISCARDED: ${event.message.link} [${cachedType}] - skipping online events (cached)`);
        debugEntries.push({
          message: event.message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: 'discarded',
          substep: '4_classification',
          cached: true,
        });
      } else {
        classifiedEvents.push({
          ...event,
          event_type: cachedType,
        });
        debugEntries.push({
          message: event.message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: cachedType,
          substep: '4_classification',
          cached: true,
        });
      }
    } else {
      uncachedEvents.push(event);
    }
  }

  if (cacheHits > 0) {
    logger.verbose(`  Cache hits: ${cacheHits}/${events.length} events`);
  }

  if (uncachedEvents.length === 0) {
    logger.verbose(`  All events cached, skipping GPT calls`);
    logger.log(`  Created ${classifiedEvents.length} classified events`);
    return classifiedEvents;
  }

  const chunks = createBatches(uncachedEvents, config.gptBatchSizeEventClassification);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.verbose(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);

    const messagesText = chunk
      .map((event, idx) => `${idx + 1}. ${event.message.content.replace(/\n/g, ' ')}`)
      .join('\n\n');
    const prompt = (config.eventTypeClassificationPrompt || '').replace('{{MESSAGES}}', messagesText);

    const result = await openaiClient.callWithDelay(prompt);
    const processedIndices = new Set<number>();

    if (result) {
      const lines = result.split('\n').filter((line) => line.trim());
      const malformedLines: string[] = [];
      const outOfRangeIndices: number[] = [];
      const invalidClassifications: Array<{ index: number; value: number }> = [];
      const duplicateIndices: number[] = [];

      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s*:\s*(\d+)$/);
        if (match) {
          const messageNum = parseInt(match[1]);
          const classificationIdx = parseInt(match[2]);
          const messageIdx = messageNum - 1;

          // Validate message index
          if (!Number.isInteger(messageNum) || messageNum < 1) {
            malformedLines.push(line);
            continue;
          }

          // Validate index is in range
          if (messageIdx < 0 || messageIdx >= chunk.length) {
            outOfRangeIndices.push(messageNum);
            continue;
          }

          // Validate classification value (0=offline, 1=online, 2=hybrid)
          if (!Number.isInteger(classificationIdx) || classificationIdx < 0 || classificationIdx > 2) {
            invalidClassifications.push({ index: messageNum, value: classificationIdx });
            continue;
          }

          // Validate no duplicate indices
          if (processedIndices.has(messageIdx)) {
            duplicateIndices.push(messageNum);
            continue;
          }

          const eventType =
            classificationIdx === 0 ? EventType.OFFLINE : classificationIdx === 1 ? EventType.ONLINE : EventType.HYBRID;

          // Cache the result
          cache.cacheEventType(chunk[messageIdx].message.link, eventType, false);
          processedIndices.add(messageIdx);

          // Check if we should include this event
          if (eventType === EventType.ONLINE && config.skipOnlineEvents) {
            logger.verbose(`    DISCARDED: ${chunk[messageIdx].message.link} [${eventType}] - skipping online events`);
            debugEntries.push({
              message: chunk[messageIdx].message,
              gpt_prompt: prompt,
              gpt_response: result,
              result: 'discarded',
              substep: '4_classification',
              cached: false,
            });
          } else {
            classifiedEvents.push({
              ...chunk[messageIdx],
              event_type: eventType,
            });
            debugEntries.push({
              message: chunk[messageIdx].message,
              gpt_prompt: prompt,
              gpt_response: result,
              result: eventType,
              substep: '4_classification',
              cached: false,
            });
          }
        } else if (line.trim() !== '') {
          malformedLines.push(line);
        }
      }

      // Log warnings for unexpected GPT output
      if (outOfRangeIndices.length > 0) {
        logger.verbose(
          `    WARNING: GPT returned out-of-range indices (valid range: 1-${chunk.length}): ${outOfRangeIndices.join(', ')}`
        );
      }
      if (invalidClassifications.length > 0) {
        const details = invalidClassifications.map((c) => `${c.index}:${c.value}`).join(', ');
        logger.verbose(`    WARNING: GPT returned invalid classification values (valid: 0-2): ${details}`);
      }
      if (duplicateIndices.length > 0) {
        logger.verbose(`    WARNING: GPT returned duplicate indices: ${duplicateIndices.join(', ')}`);
      }
      if (malformedLines.length > 0) {
        logger.verbose(
          `    WARNING: GPT returned unexpected format in lines: ${malformedLines.slice(0, 3).join(', ')}${malformedLines.length > 3 ? ` (and ${malformedLines.length - 3} more)` : ''}`
        );
      }
    }

    // Handle unprocessed events (shouldn't happen, but just in case)
    for (let idx = 0; idx < chunk.length; idx++) {
      if (!processedIndices.has(idx)) {
        logger.verbose(`    WARNING: ${chunk[idx].message.link} - no classification received, defaulting to offline`);
        const eventType = EventType.OFFLINE;
        cache.cacheEventType(chunk[idx].message.link, eventType, false);
        classifiedEvents.push({
          ...chunk[idx],
          event_type: eventType,
        });
        debugEntries.push({
          message: chunk[idx].message,
          gpt_prompt: prompt,
          gpt_response: result || '[NO RESPONSE]',
          result: eventType,
          substep: '4_classification',
          cached: false,
        });
      }
    }

    cache.save();
  }

  logger.log(`  Created ${classifiedEvents.length} classified events`);
  return classifiedEvents;
}
