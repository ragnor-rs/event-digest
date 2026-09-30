import { Config } from '../../config/types';
import { getStepReasoningEffort } from '../../config/validator';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { DebugLocationFilteringEntry } from '../../shared/types';
import { DigestEvent, EventLocation } from '../entities';
import { IAIClient, ICache } from '../interfaces';

/** What the model emits for a field it could not fill */
const UNKNOWN_FIELD = 'unknown';

/** Fields per response line: MESSAGE_NUMBER|VENUE|ADDRESS|INDEX|CONFIDENCE */
const RESPONSE_FIELD_COUNT = 5;

function toDebugMessage(event: DigestEvent): DebugLocationFilteringEntry['message'] {
  return {
    timestamp: event.message.timestamp,
    content: event.message.content,
    link: event.message.link,
  };
}

/** Renders a field the model left as "unknown" (or blank) as absent. */
function readField(raw: string): string | undefined {
  const value = raw.trim();
  return value === '' || value.toLowerCase() === UNKNOWN_FIELD ? undefined : value;
}

/**
 * Decides whether an extracted location admits the event, and records why not.
 *
 * Both the cached and the fresh path go through here, so a cache hit is judged
 * against the *current* config rather than the one in force when it was stored —
 * tightening locationFilter or includeEventsWithoutLocation has to take effect
 * without re-running GPT.
 */
function applyLocationPolicy(
  event: DigestEvent,
  location: EventLocation | null,
  aiPrompt: string,
  aiResponse: string,
  config: Config,
  logger: Logger,
  debugEntries: DebugLocationFilteringEntry[],
  cached: boolean
): DigestEvent | null {
  const suffix = cached ? ' (cached)' : '';
  const base = {
    message: toDebugMessage(event),
    event_type: event.event_type_classification!.type,
    ai_prompt: aiPrompt,
    ai_response: aiResponse,
    extracted_venue: location?.venue ?? '',
    extracted_address: location?.address ?? '',
    matched_location: location?.matched_location ?? '',
    confidence: location?.confidence ?? 0,
    cached,
  };

  const discard = (reason: string): null => {
    logger.verbose(`    ✗ Discarded: ${event.message.link} - ${reason}${suffix}`);
    debugEntries.push({ ...base, result: 'discarded', discard_reason: reason });
    return null;
  };

  // The announcement named no place at all. An online event always lands here,
  // which is why turning includeEventsWithoutLocation off drops them too.
  if (!location) {
    if (!config.includeEventsWithoutLocation) {
      return discard('no location found');
    }
    debugEntries.push({ ...base, result: 'located' });
    return event;
  }

  // No filter configured: the step is extraction only, so everything survives.
  if (config.locationFilter.length === 0) {
    debugEntries.push({ ...base, result: 'located' });
    return { ...event, event_location: location };
  }

  if (!location.matched_location) {
    return discard('outside configured locations');
  }

  if (location.confidence < config.minLocationConfidence) {
    return discard(
      `location match confidence ${location.confidence.toFixed(2)} below threshold ${config.minLocationConfidence}`
    );
  }

  debugEntries.push({ ...base, result: 'located' });
  return { ...event, event_location: location };
}

export async function filterByLocation(
  events: DigestEvent[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugLocationFilteringEntry[],
  logger: Logger
): Promise<DigestEvent[]> {
  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  const locatedEvents: DigestEvent[] = [];
  const uncachedEvents: DigestEvent[] = [];
  let cacheHits = 0;

  logger.verbose('  Processing cache...');

  for (const event of events) {
    const cachedLocation = cache.getEventLocationCache(event.message.link, config.locationFilter);
    if (cachedLocation !== undefined) {
      cacheHits++;
      const kept = applyLocationPolicy(
        event,
        cachedLocation,
        '[CACHED]',
        `[CACHED: ${cachedLocation ? cachedLocation.matched_location || 'no match' : 'no location'}]`,
        config,
        logger,
        debugEntries,
        true
      );
      if (kept) {
        locatedEvents.push(kept);
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
    logger.log(`  Found ${locatedEvents.length} events matching location`);
    return locatedEvents;
  }

  const locationsText =
    config.locationFilter.length > 0
      ? config.locationFilter.map((location, idx) => `${idx}: ${location}`).join('\n')
      : '(none — extract only, always answer -1)';

  const chunks = createBatches(uncachedEvents, config.locationExtractionBatchSize);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.verbose(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);

    const messagesText = chunk
      .map((event, idx) => `${idx + 1}. ${event.message.content.replace(/\n/g, ' ')}`)
      .join('\n\n');
    const prompt = config
      .locationExtractionPrompt!.replace('{{LOCATIONS}}', locationsText)
      .replace('{{MESSAGES}}', messagesText);

    const result = await aiClient.call(prompt, {
      reasoningEffort: getStepReasoningEffort(config, 'locationExtraction'),
    });
    const processedIndices = new Set<number>();

    if (result) {
      const lines = result.split('\n').filter((line) => line.trim());
      const malformedLines: string[] = [];
      const outOfRangeIndices: number[] = [];
      const invalidLocationIndices: Array<{ index: number; value: string }> = [];
      const duplicateIndices: number[] = [];

      for (const line of lines) {
        const parts = line.trim().split('|');
        if (parts.length < RESPONSE_FIELD_COUNT) {
          if (line.trim() !== '') {
            malformedLines.push(line);
          }
          continue;
        }

        // The three fixed fields sit at known offsets from the ends, so a venue
        // or address that kept a pipe despite the prompt is rejoined rather than
        // costing the whole line — which would lose the venue entirely. With
        // exactly five fields this is the plain positional read.
        const idxField = parts[parts.length - 2].trim();
        const messageNum = parseInt(parts[0].trim());
        const locationIdx = parseInt(idxField);
        const confidence = parseFloat(parts[parts.length - 1].trim());
        const messageIdx = messageNum - 1;

        // Validate message index
        if (!Number.isInteger(messageNum) || messageNum < 1) {
          malformedLines.push(line);
          continue;
        }

        // Validate index is in range
        if (messageIdx >= chunk.length) {
          outOfRangeIndices.push(messageNum);
          continue;
        }

        // Validate the location index points at a configured location, or -1.
        // With no filter configured there is no index to point at, so a stray
        // non-negative answer is ignored rather than rejected — dropping the
        // line would throw away the venue, which is the whole output of the
        // step in that configuration.
        if (config.locationFilter.length > 0) {
          if (!Number.isInteger(locationIdx) || locationIdx < -1 || locationIdx >= config.locationFilter.length) {
            invalidLocationIndices.push({ index: messageNum, value: idxField });
            continue;
          }
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

        const venue = readField(parts[1]);
        const address = readField(parts.slice(2, parts.length - 2).join(', '));
        const matchedLocation =
          config.locationFilter.length > 0 && locationIdx >= 0 ? config.locationFilter[locationIdx] : undefined;

        // Nothing usable came back: cache a negative result rather than an
        // empty location, so the "no place stated" policy has something to act on.
        const location: EventLocation | null =
          venue || address || matchedLocation
            ? { venue, address, matched_location: matchedLocation, confidence }
            : null;

        cache.cacheEventLocation(chunk[messageIdx].message.link, location, config.locationFilter, false);
        processedIndices.add(messageIdx);

        const kept = applyLocationPolicy(
          chunk[messageIdx],
          location,
          prompt,
          result,
          config,
          logger,
          debugEntries,
          false
        );
        if (kept) {
          locatedEvents.push(kept);
        }
      }

      // Log warnings for unexpected AI output
      if (outOfRangeIndices.length > 0) {
        logger.verbose(
          `    WARNING: AI returned out-of-range indices (valid range: 1-${chunk.length}): ${outOfRangeIndices.join(', ')}`
        );
      }
      if (invalidLocationIndices.length > 0) {
        const details = invalidLocationIndices.map((c) => `${c.index}:${c.value}`).join(', ');
        logger.verbose(
          `    WARNING: AI returned invalid location indices (valid: -1 to ${config.locationFilter.length - 1}): ${details}`
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
    }

    // Events the AI skipped are treated as "no location stated". A line the
    // model omitted from an otherwise good answer is cached as such, so the run
    // stays deterministic instead of re-asking every time — but an empty reply
    // is a transient failure, and caching the whole batch as location-less would
    // permanently discard venues the next run would have extracted.
    for (let idx = 0; idx < chunk.length; idx++) {
      if (!processedIndices.has(idx)) {
        logger.verbose(`    WARNING: ${chunk[idx].message.link} - no location returned`);
        if (result) {
          cache.cacheEventLocation(chunk[idx].message.link, null, config.locationFilter, false);
        }
        const kept = applyLocationPolicy(
          chunk[idx],
          null,
          prompt,
          result || '[NO RESPONSE]',
          config,
          logger,
          debugEntries,
          false
        );
        if (kept) {
          locatedEvents.push(kept);
        }
      }
    }

    cache.save();
  }

  logger.log(`  Found ${locatedEvents.length} events matching location`);
  return locatedEvents;
}
