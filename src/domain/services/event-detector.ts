import { Config } from '../../config/types';
import { Cache } from '../../data/cache';
import { OpenAIClient } from '../../data/openai-client';
import { DebugEventDetectionEntry } from '../../presentation/debug-writer';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { TelegramMessage, Event } from '../entities';

export async function detectEventAnnouncements(
  messages: TelegramMessage[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugEntries: DebugEventDetectionEntry[],
  logger: Logger
): Promise<Event[]> {
  logger.log(`Detecting event announcements with GPT from ${messages.length} messages...`);

  if (messages.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  logger.verbose(`  Processing cache...`);

  // Check cache first
  const uncachedMessages: TelegramMessage[] = [];
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
        logger.verbose(`    DISCARDED: ${message.link} - not an event announcement (cached)`);
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
    logger.verbose(`  All messages cached, skipping GPT calls`);
    logger.log(`  GPT identified ${events.length} event messages`);
    return events;
  }

  const chunks = createBatches(uncachedMessages, config.gptBatchSizeEventDetection);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const prompt = config.eventDetectionPrompt!.replace(
      '{{MESSAGES}}',
      chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')
    );

    const result = await openaiClient.callWithDelay(prompt);

    if (result && result !== 'none') {
      const lines = result.split('\n').filter((line) => line.trim());
      const processedIndices = new Set<number>();

      for (const line of lines) {
        const match = line.trim().match(/^(\d+)$/);
        if (match) {
          const idx = parseInt(match[1]) - 1;

          if (idx >= 0 && idx < chunk.length) {
            events.push({ message: chunk[idx] });
            cache.cacheEventMessage(chunk[idx].link, true, false);
            processedIndices.add(idx);

            debugEntries.push({
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
          logger.verbose(`    DISCARDED: ${chunk[idx].link} - not an event announcement`);
          cache.cacheEventMessage(chunk[idx].link, false, false);

          debugEntries.push({
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
        logger.verbose(`    DISCARDED: ${message.link} - not an event announcement`);
        cache.cacheEventMessage(message.link, false, false);

        debugEntries.push({
          messageLink: message.link,
          isEvent: false,
          cached: false,
          prompt,
          gptResponse: result || 'none',
        });
      }
    }

    // Save cache after processing batch
    cache.save();
  }

  logger.log(`  GPT identified ${events.length} event messages`);
  return events;
}
