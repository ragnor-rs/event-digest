import { Config } from '../../config/types';
import { IAIClient, ICache } from '../interfaces';
import { DebugEventDetectionEntry } from '../types';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { SourceMessage, Event } from '../entities';

export async function detectEventAnnouncements(
  messages: SourceMessage[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugEventDetectionEntry[],
  logger: Logger
): Promise<Event[]> {
  if (messages.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  logger.verbose(`  Processing cache...`);

  // Check cache first
  const uncachedMessages: SourceMessage[] = [];
  const events: Event[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedResult = cache.isEventMessageCached(message.link);
    if (cachedResult !== undefined) {
      cacheHits++;
      if (cachedResult) {
        events.push({ message });
        debugEntries.push({
          messageLink: message.link,
          isEvent: true,
          cached: true,
        });
      } else {
        logger.verbose(`    ✗ Discarded: ${message.link} - not an event announcement (cached)`);
        debugEntries.push({
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
    logger.verbose(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    logger.verbose(`  All messages cached, skipping AI calls`);
    logger.log(`  AI identified ${events.length} event messages`);
    return events;
  }

  const chunks = createBatches(uncachedMessages, config.eventDetectionBatchSize);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const prompt = config.eventDetectionPrompt!.replace(
      '{{MESSAGES}}',
      chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')
    );

    const result = await aiClient.call(prompt);

    if (result && result !== 'none') {
      const lines = result.split('\n').filter((line) => line.trim());
      const processedIndices = new Set<number>();
      const malformedLines: string[] = [];
      const outOfRangeIndices: number[] = [];
      const duplicateIndices: number[] = [];

      for (const line of lines) {
        const match = line.trim().match(/^(\d+)$/);
        if (match) {
          const messageNum = parseInt(match[1]);
          const idx = messageNum - 1;

          // Validate index is a positive integer
          if (!Number.isInteger(messageNum) || messageNum < 1) {
            malformedLines.push(line);
            continue;
          }

          // Validate index is in range
          if (idx < 0 || idx >= chunk.length) {
            outOfRangeIndices.push(messageNum);
            continue;
          }

          // Validate no duplicate indices
          if (processedIndices.has(idx)) {
            duplicateIndices.push(messageNum);
            continue;
          }

          events.push({ message: chunk[idx] });
          cache.cacheEventMessage(chunk[idx].link, true, false);
          processedIndices.add(idx);

          debugEntries.push({
            messageLink: chunk[idx].link,
            isEvent: true,
            cached: false,
            prompt,
            aiResponse: result,
          });
        } else if (line.trim() !== '' && !line.toLowerCase().includes('none')) {
          malformedLines.push(line);
        }
      }

      // Log warnings for unexpected AI output
      if (outOfRangeIndices.length > 0) {
        logger.verbose(
          `    WARNING: AI returned out-of-range indices (valid range: 1-${chunk.length}): ${outOfRangeIndices.join(', ')}`
        );
      }
      if (duplicateIndices.length > 0) {
        logger.verbose(`    WARNING: AI returned duplicate indices: ${duplicateIndices.join(', ')}`);
      }
      if (malformedLines.length > 0) {
        logger.verbose(
          `    WARNING: AI returned unexpected format in lines: ${malformedLines.slice(0, 3).join(', ')}${malformedLines.length > 3 ? ` (and ${malformedLines.length - 3} more)` : ''}`
        );
      }

      // Cache negative results for unprocessed messages
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedIndices.has(idx)) {
          logger.verbose(`    ✗ Discarded: ${chunk[idx].link} - not an event announcement`);
          cache.cacheEventMessage(chunk[idx].link, false, false);

          debugEntries.push({
            messageLink: chunk[idx].link,
            isEvent: false,
            cached: false,
            prompt,
            aiResponse: result,
          });
        }
      }
    } else {
      // All messages in chunk are not events
      for (const message of chunk) {
        logger.verbose(`    ✗ Discarded: ${message.link} - not an event announcement`);
        cache.cacheEventMessage(message.link, false, false);

        debugEntries.push({
          messageLink: message.link,
          isEvent: false,
          cached: false,
          prompt,
          aiResponse: result || 'none',
        });
      }
    }

    // Save cache after processing batch
    cache.save();
  }

  logger.log(`  AI identified ${events.length} event messages`);
  return events;
}
