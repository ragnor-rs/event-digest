import { Event, InterestMatch } from '../entities';
import { Config } from '../../config/types';
import { OpenAIClient } from '../../data/openai-client';
import { Cache } from '../../data/cache';
import { Logger } from '../../shared/logger';

interface DebugEntry {
  message: any;
  event_type: string;
  start_datetime: string;
  gpt_prompt: string;
  gpt_response: string;
  interests_matched: string[];
  interest_matches?: InterestMatch[];
  result: 'matched' | 'discarded';
  cached: boolean;
}

export async function filterByInterests(
  events: Event[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugEntries: DebugEntry[],
  logger: Logger
): Promise<Event[]> {
  logger.log(`Matching ${events.length} events to user interests...`);

  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  // Check cache first
  const uncachedEvents: Event[] = [];
  const matchedEvents: Event[] = [];
  let cacheHits = 0;

  if (config.verboseLogging) {
    console.log('  Processing cache...');
  }

  for (const event of events) {
    const cachedInterests = cache.getMatchingInterestsCache(event.message.link, config.userInterests);
    if (cachedInterests !== undefined) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        // For cached results, we don't have confidence scores, so assume they all passed threshold (1.0)
        const cachedMatches = cachedInterests.map((interest) => ({
          interest,
          confidence: 1.0,
        }));
        matchedEvents.push({
          ...event,
          interests_matched: cachedInterests,
          interest_matches: cachedMatches,
        });
        debugEntries.push({
          start_datetime: event.start_datetime!,
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: matched interests: ${cachedInterests.join(', ')}]`,
          interests_matched: cachedInterests,
          interest_matches: cachedMatches,
          result: 'matched',
          cached: true,
        });
      } else {
        if (config.verboseLogging) {
          console.log(`    DISCARDED: ${event.message.link} - no interests matched (cached)`);
        }
        debugEntries.push({
          start_datetime: event.start_datetime!,
          message: event.message,
          event_type: event.event_type!,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: no interests matched]',
          interests_matched: [],
          interest_matches: [],
          result: 'discarded',
          cached: true,
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
    logger.log(`  Found ${matchedEvents.length} events matching user interests`);
    return matchedEvents;
  }

  // Process each event individually
  for (let i = 0; i < uncachedEvents.length; i++) {
    const event: Event = uncachedEvents[i];
    if (config.verboseLogging) {
      console.log(`  Processing event ${i + 1}/${uncachedEvents.length}...`);
    }

    const eventsText = `0: ${event.message.content.replace(/\n/g, ' ')}`;

    const interestsText = config.userInterests.map((interest: string, idx: number) => `${idx}: ${interest}`).join('\n');

    const prompt: string = (config.interestMatchingPrompt || '')
      .replace('{{EVENTS}}', eventsText)
      .replace('{{INTERESTS}}', interestsText);

    const result = await openaiClient.callWithDelay(prompt);

    if (!result) {
      // GPT returned undefined/empty - technical issue
      if (config.verboseLogging) {
        console.log(`    DISCARDED: ${event.message.link} - GPT returned no response`);
      }
      cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
      debugEntries.push({
        start_datetime: event.start_datetime!,
        message: event.message,
        event_type: event.event_type!,
        gpt_prompt: prompt,
        gpt_response: '[NO RESPONSE - EMPTY]',
        interests_matched: [],
        result: 'discarded',
        cached: false,
      });
    } else if (result.toLowerCase() === 'none') {
      // GPT explicitly said "none" - legitimate no match
      if (config.verboseLogging) {
        console.log(`    DISCARDED: ${event.message.link} - GPT returned "none"`);
      }
      cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
      debugEntries.push({
        message: event.message,
        event_type: event.event_type!,
        start_datetime: event.start_datetime!,
        gpt_prompt: prompt,
        gpt_response: 'none',
        interests_matched: [],
        result: 'discarded',
        cached: false,
      });
    } else {
      // GPT returned interest indices with confidence scores
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

      // Filter by confidence threshold and validate indices
      const validMatches = interestMatches.filter(
        (m) => m.confidence >= config.minInterestConfidence && m.index >= 0 && m.index < config.userInterests.length
      );

      // Warn about invalid indices
      const invalidIndices = interestMatches
        .filter((m) => m.index < 0 || m.index >= config.userInterests.length)
        .map((m) => m.index);
      if (config.verboseLogging && invalidIndices.length > 0) {
        console.log(`    WARNING: GPT returned invalid interest indices: ${invalidIndices.join(', ')}`);
      }

      // Warn about low-confidence matches
      const lowConfidenceMatches = interestMatches.filter(
        (m) => m.confidence < config.minInterestConfidence && m.index >= 0 && m.index < config.userInterests.length
      );
      if (config.verboseLogging && lowConfidenceMatches.length > 0) {
        const lowConfDetails = lowConfidenceMatches
          .map((m) => `${config.userInterests[m.index]}(${m.confidence.toFixed(2)})`)
          .join(', ');
        console.log(`    Filtered out low-confidence matches: ${lowConfDetails}`);
      }

      // Convert to interest names (for backward compat) and InterestMatch objects
      const matchedInterests: string[] = validMatches.map((m) => config.userInterests[m.index]);
      const interestMatchesWithNames: Array<{ interest: string; confidence: number }> = validMatches.map((m) => ({
        interest: config.userInterests[m.index],
        confidence: m.confidence,
      }));

      if (matchedInterests.length > 0) {
        matchedEvents.push({
          ...event,
          interests_matched: matchedInterests,
          interest_matches: interestMatchesWithNames,
        });
        cache.cacheMatchingInterests(event.message.link, matchedInterests, config.userInterests, false);

        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          start_datetime: event.start_datetime!,
          gpt_prompt: prompt,
          gpt_response: result,
          interests_matched: matchedInterests,
          interest_matches: interestMatchesWithNames,
          result: 'matched',
          cached: false,
        });
      } else {
        // Parsed result but no valid interests (all filtered out by confidence or invalid indices)
        if (config.verboseLogging) {
          const reason =
            interestMatches.length > 0
              ? 'all matches below confidence threshold or invalid indices'
              : 'no valid interests parsed from response';
          console.log(`    DISCARDED: ${event.message.link} - ${reason}`);
        }
        cache.cacheMatchingInterests(event.message.link, [], config.userInterests, false);
        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          start_datetime: event.start_datetime!,
          gpt_prompt: prompt,
          gpt_response: result,
          interests_matched: [],
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
