import { TelegramMessage, Event } from '../entities';
import { Config } from '../../config/types';
import { OpenAIClient } from '../../data/openai-client';
import { Cache } from '../../data/cache';
import { createBatches } from '../../shared/batch-processor';

interface DebugEntry {
  messageLink: string;
  isEvent: boolean;
  cached: boolean;
  prompt?: string;
  gptResponse?: string;
}

export async function detectEventAnnouncements(
  messages: TelegramMessage[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugResults: DebugEntry[]
): Promise<Event[]> {
  console.log(`Detecting event announcements with GPT from ${messages.length} messages...`);

  if (messages.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  if (config.verboseLogging) {
    console.log(`  Processing cache...`);
  }

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
    return events;
  }

  const chunks = createBatches(uncachedMessages, config.gptBatchSizeEventDetection);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const prompt = config.eventDetectionPrompt!.replace(
      '{{MESSAGES}}',
      chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')
    );

    const result = await openaiClient.callWithDelay(prompt);

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

    // Save cache after processing batch
    cache.save();
  }

  console.log(`  GPT identified ${events.length} event messages`);
  return events;
}
