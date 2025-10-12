import { Event } from '../entities';
import { Config } from '../../config/types';
import { OpenAIClient } from '../../data/openai-client';
import { Cache } from '../../data/cache';
import { createBatches } from '../../shared/batch-processor';

interface DebugEntry {
  message: any;
  gpt_prompt: string;
  gpt_response: string;
  result: 'hybrid' | 'offline' | 'online' | 'discarded';
  substep: '4_classification';
  cached: boolean;
}

export async function classifyEventTypes(
  events: Event[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugEntries: DebugEntry[]
): Promise<Event[]> {
  console.log(`Classifying event types for ${events.length} events...`);

  if (events.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

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
        debugEntries.push({
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
        debugEntries.push({
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

  const chunks = createBatches(uncachedEvents, config.gptBatchSizeEventClassification);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (config.verboseLogging) {
      console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);
    }

    const messagesText = chunk.map((event, idx) => `${idx + 1}. ${event.message.content.replace(/\n/g, ' ')}`).join('\n\n');
    const prompt = (config.eventTypeClassificationPrompt || '').replace('{{MESSAGES}}', messagesText);

    const result = await openaiClient.callWithDelay(prompt);
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
              debugEntries.push({
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
              debugEntries.push({
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
        debugEntries.push({
          message: chunk[idx].message,
          gpt_prompt: prompt,
          gpt_response: result || '[NO RESPONSE]',
          result: eventType,
          substep: '4_classification',
          cached: false
        });
      }
    }

    cache.save();
  }

  console.log(`  Created ${classifiedEvents.length} classified events`);
  return classifiedEvents;
}
