import { Config } from '../../config/types';
import { getStepReasoningEffort } from '../../config/validator';
import { IAIClient, ICache } from '../interfaces';
import { DebugEventDetectionEntry } from '../../shared/types';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { SourceMessage, DigestEvent } from '../entities';

export async function detectEventAnnouncements(
  messages: SourceMessage[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugEventDetectionEntry[],
  logger: Logger
): Promise<DigestEvent[]> {
  if (messages.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  logger.verbose(`  Processing cache...`);

  // Check cache first
  const uncachedMessages: SourceMessage[] = [];
  const events: DigestEvent[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cached = cache.getEventDetectionCache(message.link);
    if (cached !== undefined) {
      cacheHits++;

      // The threshold is applied here rather than before the write, so changing
      // minEventDetectionConfidence takes effect on already-seen messages
      // without re-running the step. Entries predating the stored score have no
      // confidence and are taken at their recorded verdict.
      const confidence = cached.confidence;
      const meetsThreshold = (confidence ?? 1) >= config.minEventDetectionConfidence;

      if (cached.isEvent && meetsThreshold) {
        events.push({ message, event_detection_confidence: confidence });
        debugEntries.push({
          messageLink: message.link,
          messageContent: message.content,
          isEvent: true,
          confidence,
          cached: true,
        });
      } else {
        const reason = cached.isEvent
          ? `event confidence ${confidence!.toFixed(2)} below threshold ${config.minEventDetectionConfidence}`
          : 'not an event announcement';
        logger.verbose(`    ✗ Discarded: ${message.link} - ${reason} (cached)`);
        debugEntries.push({
          messageLink: message.link,
          messageContent: message.content,
          isEvent: false,
          confidence,
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

    const result = await aiClient.call(prompt, {
      reasoningEffort: getStepReasoningEffort(config, 'eventDetection'),
    });

    if (result && result !== 'none') {
      const lines = result.split('\n').filter((line) => line.trim());
      const processedIndices = new Set<number>();
      const malformedLines: string[] = [];
      const outOfRangeIndices: number[] = [];
      const duplicateIndices: number[] = [];
      const lowConfidenceFiltered: Array<{ messageNum: number; confidence: number }> = [];

      for (const line of lines) {
        // Try to match "NUMBER:CONFIDENCE" format
        const matchWithConfidence = line.trim().match(/^(\d+):([0-9.]+)$/);
        if (matchWithConfidence) {
          const messageNum = parseInt(matchWithConfidence[1]);
          const confidence = parseFloat(matchWithConfidence[2]);
          const idx = messageNum - 1;

          // Validate index is a positive integer
          if (!Number.isInteger(messageNum) || messageNum < 1) {
            malformedLines.push(line);
            continue;
          }

          // Validate confidence is in valid range
          if (isNaN(confidence) || confidence < 0 || confidence > 1) {
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

          // Filter by minimum confidence threshold
          if (confidence < config.minEventDetectionConfidence) {
            lowConfidenceFiltered.push({ messageNum, confidence });
            logger.verbose(
              `    ✗ Discarded: ${chunk[idx].link} - event confidence ${confidence.toFixed(2)} below threshold ${config.minEventDetectionConfidence}`
            );
            // Cached as the model saw it — an event, with its score. The
            // threshold that rejected it is policy, and policy is applied on read.
            cache.cacheEventDetection(chunk[idx].link, { isEvent: true, confidence }, false);
            debugEntries.push({
              messageLink: chunk[idx].link,
              messageContent: chunk[idx].content,
              isEvent: false,
              confidence,
              cached: false,
              prompt,
              aiResponse: result,
            });
            processedIndices.add(idx);
            continue;
          }

          events.push({ message: chunk[idx], event_detection_confidence: confidence });
          cache.cacheEventDetection(chunk[idx].link, { isEvent: true, confidence }, false);
          processedIndices.add(idx);

          debugEntries.push({
            messageLink: chunk[idx].link,
            messageContent: chunk[idx].content,
            isEvent: true,
            confidence,
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
        logger.verbose(
          `    WARNING: AI returned duplicate indices: ${duplicateIndices.join(', ')}`
        );
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
          cache.cacheEventDetection(chunk[idx].link, { isEvent: false }, false);

          debugEntries.push({
            messageLink: chunk[idx].link,
            messageContent: chunk[idx].content,
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
        cache.cacheEventDetection(message.link, { isEvent: false }, false);

        debugEntries.push({
          messageLink: message.link,
          messageContent: message.content,
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
