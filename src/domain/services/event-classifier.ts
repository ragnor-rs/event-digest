import { Config } from '../../config/types';
import { IAIClient, ICache } from '../interfaces';
import { DebugTypeClassificationEntry } from '../../shared/types';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { DigestEvent, AttendanceMode } from '../entities';

export async function classifyEventTypes(
  events: DigestEvent[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugTypeClassificationEntry[],
  logger: Logger
): Promise<DigestEvent[]> {
  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  const classifiedEvents: DigestEvent[] = [];
  const uncachedEvents: DigestEvent[] = [];
  let cacheHits = 0;

  logger.verbose('  Processing cache...');

  for (const event of events) {
    const cachedClassification = cache.getEventTypeCache(event.message.link);
    if (cachedClassification !== undefined) {
      cacheHits++;

      // Check if we should include this event based on skipOnlineEvents
      if (cachedClassification.type === AttendanceMode.ONLINE && config.skipOnlineEvents) {
        logger.verbose(`    ✗ Discarded: ${event.message.link} [${cachedClassification.type}] - skipping online events (cached)`);
        debugEntries.push({
          message: {
            timestamp: event.message.timestamp,
            content: event.message.content,
            link: event.message.link,
          },
          ai_prompt: '[CACHED]',
          ai_response: `[CACHED: ${cachedClassification.type}, confidence: ${cachedClassification.confidence}]`,
          type_classifications: [{ type: cachedClassification.type as 'offline' | 'online' | 'hybrid', confidence: cachedClassification.confidence }],
          result: 'discarded',
          cached: true,
        });
      } else {
        classifiedEvents.push({
          ...event,
          event_type_classification: cachedClassification,
        });
        debugEntries.push({
          message: {
            timestamp: event.message.timestamp,
            content: event.message.content,
            link: event.message.link,
          },
          ai_prompt: '[CACHED]',
          ai_response: `[CACHED: ${cachedClassification.type}, confidence: ${cachedClassification.confidence}]`,
          type_classifications: [{ type: cachedClassification.type as 'offline' | 'online' | 'hybrid', confidence: cachedClassification.confidence }],
          result: 'matched',
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
    logger.verbose(`  All events cached, skipping AI calls`);
    logger.log(`  Created ${classifiedEvents.length} classified events`);
    return classifiedEvents;
  }

  const chunks = createBatches(uncachedEvents, config.eventClassificationBatchSize);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.verbose(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);

    const messagesText = chunk
      .map((event, idx) => `${idx + 1}. ${event.message.content.replace(/\n/g, ' ')}`)
      .join('\n\n');
    const prompt = (config.eventTypeClassificationPrompt || '').replace('{{MESSAGES}}', messagesText);

    const result = await aiClient.call(prompt);
    const processedIndices = new Set<number>();

    if (result) {
      const lines = result.split('\n').filter((line) => line.trim());
      const malformedLines: string[] = [];
      const outOfRangeIndices: number[] = [];
      const invalidClassifications: Array<{ index: number; value: number }> = [];
      const duplicateIndices: number[] = [];

      const lowConfidenceFiltered: Array<{ messageNum: number; confidence: number }> = [];

      for (const line of lines) {
        // Try to match "NUMBER:INDEX:CONFIDENCE" format
        const match = line.trim().match(/^(\d+)\s*:\s*(\d+)\s*:\s*([0-9.]+)$/);
        if (match) {
          const messageNum = parseInt(match[1]);
          const classificationIdx = parseInt(match[2]);
          const confidence = parseFloat(match[3]);
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

          // Validate confidence is in valid range
          if (isNaN(confidence) || confidence < 0 || confidence > 1) {
            malformedLines.push(line);
            continue;
          }

          // Validate no duplicate indices
          if (processedIndices.has(messageIdx)) {
            duplicateIndices.push(messageNum);
            continue;
          }

          const eventType =
            classificationIdx === 0 ? AttendanceMode.OFFLINE : classificationIdx === 1 ? AttendanceMode.ONLINE : AttendanceMode.HYBRID;

          const classification = { type: eventType, confidence };

          // Filter by minimum confidence threshold
          if (confidence < config.minEventClassificationConfidence) {
            lowConfidenceFiltered.push({ messageNum, confidence });
            logger.verbose(
              `    ✗ Discarded: ${chunk[messageIdx].message.link} [${eventType}] - classification confidence ${confidence.toFixed(2)} below threshold ${config.minEventClassificationConfidence}`
            );
            debugEntries.push({
              message: {
                timestamp: chunk[messageIdx].message.timestamp,
                content: chunk[messageIdx].message.content,
                link: chunk[messageIdx].message.link,
              },
              ai_prompt: prompt,
              ai_response: result,
              type_classifications: [{ type: eventType as 'offline' | 'online' | 'hybrid', confidence }],
              result: 'discarded',
              cached: false,
            });
            processedIndices.add(messageIdx);
            continue;
          }

          // Cache the result
          cache.cacheEventType(chunk[messageIdx].message.link, classification, false);
          processedIndices.add(messageIdx);

          // Check if we should include this event
          if (eventType === AttendanceMode.ONLINE && config.skipOnlineEvents) {
            logger.verbose(`    ✗ Discarded: ${chunk[messageIdx].message.link} [${eventType}] - skipping online events`);
            debugEntries.push({
              message: {
                timestamp: chunk[messageIdx].message.timestamp,
                content: chunk[messageIdx].message.content,
                link: chunk[messageIdx].message.link,
              },
              ai_prompt: prompt,
              ai_response: result,
              type_classifications: [{ type: eventType as 'offline' | 'online' | 'hybrid', confidence }],
              result: 'discarded',
              cached: false,
            });
          } else {
            classifiedEvents.push({
              ...chunk[messageIdx],
              event_type_classification: classification,
            });
            debugEntries.push({
              message: {
                timestamp: chunk[messageIdx].message.timestamp,
                content: chunk[messageIdx].message.content,
                link: chunk[messageIdx].message.link,
              },
              ai_prompt: prompt,
              ai_response: result,
              type_classifications: [{ type: eventType as 'offline' | 'online' | 'hybrid', confidence }],
              result: 'matched',
              cached: false,
            });
          }
        } else if (line.trim() !== '') {
          malformedLines.push(line);
        }
      }

      // Log warnings for unexpected AI output
      if (outOfRangeIndices.length > 0) {
        logger.verbose(
          `    WARNING: AI returned out-of-range indices (valid range: 1-${chunk.length}): ${outOfRangeIndices.join(', ')}`
        );
      }
      if (invalidClassifications.length > 0) {
        const details = invalidClassifications.map((c) => `${c.index}:${c.value}`).join(', ');
        logger.verbose(
          `    WARNING: AI returned invalid classification values (valid: 0-2): ${details}`
        );
      }
      if (duplicateIndices.length > 0) {
        logger.verbose(
          `    WARNING: AI returned duplicate indices: ${duplicateIndices.join(', ')}`
        );
      }
      if (malformedLines.length > 0) {
        logger.verbose(
          `    WARNING: AI returned unexpected format in lines: ${malformedLines.slice(0, 3).join(', ')}${malformedLines.length > 3 ? ` (and ${malformedLines.length - 3} more)` : ''}`
        );
      }
    }

    // Handle unprocessed events (shouldn't happen, but just in case)
    for (let idx = 0; idx < chunk.length; idx++) {
      if (!processedIndices.has(idx)) {
        logger.verbose(`    WARNING: ${chunk[idx].message.link} - no classification received, defaulting to offline`);
        const classification = { type: AttendanceMode.OFFLINE, confidence: 0.5 };
        cache.cacheEventType(chunk[idx].message.link, classification, false);
        classifiedEvents.push({
          ...chunk[idx],
          event_type_classification: classification,
        });
        debugEntries.push({
          message: {
            timestamp: chunk[idx].message.timestamp,
            content: chunk[idx].message.content,
            link: chunk[idx].message.link,
          },
          ai_prompt: prompt,
          ai_response: result || '[NO RESPONSE]',
          type_classifications: [{ type: 'offline', confidence: 0.5 }],
          result: 'matched',
          cached: false,
        });
      }
    }

    cache.save();
  }

  logger.log(`  Created ${classifiedEvents.length} classified events`);
  return classifiedEvents;
}
