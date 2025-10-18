import { Config } from '../../config/types';
import { IAIClient, ICache } from '../interfaces';
import { DebugInterestMatchingEntry } from '../../shared/types';
import { Logger } from '../../shared/logger';
import { DigestEvent } from '../entities';

export async function filterByInterests(
  events: DigestEvent[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugInterestMatchingEntry[],
  logger: Logger
): Promise<DigestEvent[]> {
  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  // Check cache first
  const uncachedEvents: DigestEvent[] = [];
  const matchedEvents: DigestEvent[] = [];
  let cacheHits = 0;

  logger.verbose('  Processing cache...');

  for (const event of events) {
    const cachedInterests = cache.getMatchingInterestsCache(event.message.link, config.userInterests);
    if (cachedInterests !== undefined) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        matchedEvents.push({
          ...event,
          interest_matches: cachedInterests,
        });
        const interestNames = cachedInterests.map((m) => m.interest).join(', ');
        debugEntries.push({
          start_datetime: event.start_datetime!,
          message: {
            timestamp: event.message.timestamp,
            content: event.message.content,
            link: event.message.link,
          },
          event_type: event.event_type!,
          ai_prompt: '[CACHED]',
          ai_response: `[CACHED: matched interests: ${interestNames}]`,
          interest_matches: cachedInterests.map((m) => ({ interest: m.interest, confidence: m.confidence })),
          result: 'matched',
          cached: true,
        });
      } else {
        logger.verbose(`    ✗ Discarded: ${event.message.link} - no interests matched (cached)`);
        debugEntries.push({
          start_datetime: event.start_datetime!,
          message: {
            timestamp: event.message.timestamp,
            content: event.message.content,
            link: event.message.link,
          },
          event_type: event.event_type!,
          ai_prompt: '[CACHED]',
          ai_response: '[CACHED: no interests matched]',
          interest_matches: [],
          result: 'discarded',
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
    logger.log(`  Found ${matchedEvents.length} events matching user interests`);
    return matchedEvents;
  }

  // Process each event individually
  for (let i = 0; i < uncachedEvents.length; i++) {
    const event: DigestEvent = uncachedEvents[i];
    logger.verbose(`  Processing event ${i + 1}/${uncachedEvents.length}...`);

    const eventsText = `0: ${event.message.content.replace(/\n/g, ' ')}`;

    const interestsText = config.userInterests.map((interest: string, idx: number) => `${idx}: ${interest}`).join('\n');

    const prompt: string = (config.interestMatchingPrompt || '')
      .replace('{{EVENTS}}', eventsText)
      .replace('{{INTERESTS}}', interestsText);

    const result = await aiClient.call(prompt);

    if (!result) {
      // AI returned undefined/empty - technical issue
      logger.verbose(`    ✗ Discarded: ${event.message.link} - AI returned no response`);
      cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
      debugEntries.push({
        start_datetime: event.start_datetime!,
        message: {
          timestamp: event.message.timestamp,
          content: event.message.content,
          link: event.message.link,
        },
        event_type: event.event_type!,
        ai_prompt: prompt,
        ai_response: '[NO RESPONSE - EMPTY]',
        interest_matches: [],
        result: 'discarded',
        cached: false,
      });
    } else if (result.toLowerCase() === 'none') {
      // AI explicitly said "none" - legitimate no match
      logger.verbose(`    ✗ Discarded: ${event.message.link} - AI returned "none"`);
      cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
      debugEntries.push({
        message: {
          timestamp: event.message.timestamp,
          content: event.message.content,
          link: event.message.link,
        },
        event_type: event.event_type!,
        start_datetime: event.start_datetime!,
        ai_prompt: prompt,
        ai_response: 'none',
        interest_matches: [],
        result: 'discarded',
        cached: false,
      });
    } else {
      // AI returned interest indices with confidence scores
      // Format: "INDEX:CONFIDENCE, INDEX:CONFIDENCE" e.g., "19:0.95, 6:0.85"
      const matchPairs = result.split(',').map((s: string) => s.trim());
      const interestMatches: { index: number; confidence: number }[] = [];

      for (const pair of matchPairs) {
        const parts = pair.split(':');
        if (parts.length === 2) {
          const idx = parseInt(parts[0].trim());
          const conf = parseFloat(parts[1].trim());
          if (!isNaN(idx) && !isNaN(conf)) {
            interestMatches.push({ index: idx, confidence: conf });
          }
        } else {
          // Fallback: try parsing as just index (backward compatibility)
          const idx = parseInt(pair);
          if (!isNaN(idx)) {
            interestMatches.push({ index: idx, confidence: 1.0 });
          }
        }
      }

      // Process matches in a single pass (more efficient than multiple filters)
      const validMatches: typeof interestMatches = [];
      const invalidIndices: number[] = [];
      const lowConfidenceMatches: Array<{ interest: string; confidence: number }> = [];

      for (const match of interestMatches) {
        const isValidIndex = match.index >= 0 && match.index < config.userInterests.length;

        if (!isValidIndex) {
          invalidIndices.push(match.index);
        } else if (match.confidence < config.minInterestConfidence) {
          lowConfidenceMatches.push({
            interest: config.userInterests[match.index],
            confidence: match.confidence,
          });
        } else {
          validMatches.push(match);
        }
      }

      // Log warnings
      if (invalidIndices.length > 0) {
        logger.verbose(`    WARNING: AI returned invalid interest indices: ${invalidIndices.join(', ')}`);
      }
      if (lowConfidenceMatches.length > 0) {
        const lowConfDetails = lowConfidenceMatches.map((m) => `${m.interest}(${m.confidence.toFixed(2)})`).join(', ');
        logger.verbose(`    Filtered out low-confidence matches: ${lowConfDetails}`);
      }

      // Convert to InterestMatch objects
      const interestMatchesWithNames: Array<{ interest: string; confidence: number }> = validMatches.map((m) => ({
        interest: config.userInterests[m.index],
        confidence: m.confidence,
      }));

      if (interestMatchesWithNames.length > 0) {
        matchedEvents.push({
          ...event,
          interest_matches: interestMatchesWithNames,
        });
        cache.cacheMatchingInterests(event.message.link, interestMatchesWithNames, config.userInterests, false);

        debugEntries.push({
          message: {
            timestamp: event.message.timestamp,
            content: event.message.content,
            link: event.message.link,
          },
          event_type: event.event_type!,
          start_datetime: event.start_datetime!,
          ai_prompt: prompt,
          ai_response: result,
          interest_matches: interestMatchesWithNames.map((m) => ({ interest: m.interest, confidence: m.confidence })),
          result: 'matched',
          cached: false,
        });
      } else {
        // Parsed result but no valid interests (all filtered out by confidence or invalid indices)
        const reason =
          interestMatches.length > 0
            ? 'all matches below confidence threshold or invalid indices'
            : 'no valid interests parsed from response';
        logger.verbose(`    ✗ Discarded: ${event.message.link} - ${reason}`);
        cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
        debugEntries.push({
          message: {
            timestamp: event.message.timestamp,
            content: event.message.content,
            link: event.message.link,
          },
          event_type: event.event_type!,
          start_datetime: event.start_datetime!,
          ai_prompt: prompt,
          ai_response: result,
          interest_matches: [],
          result: 'discarded',
          cached: false,
        });
      }
    }

    // Save cache after processing each event
    cache.save();
  }

  logger.log(`  Found ${matchedEvents.length} events matching user interests`);

  return matchedEvents;
}
