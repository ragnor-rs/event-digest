import { Config } from '../../config/types';
import { getStepReasoningEffort } from '../../config/validator';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { DebugDigestSplittingEntry } from '../../shared/types';
import { SourceMessage } from '../entities';
import { IAIClient, ICache } from '../interfaces';

/**
 * How many of a signal a message needs before it is worth asking the model
 * whether it is a digest.
 *
 * A gate exists at all because the splitter is the most expensive call per
 * message in the pipeline — a digest's answer repeats every event in it — and
 * most messages are plainly not digests. Raising recall here is cheap in code
 * and not in tokens, so the threshold is set from measurement rather than taste.
 */
const MIN_DIGEST_SIGNALS = 3;

/** 19:30, 9:05, 19.30 — the way a programme lists its entries */
const CLOCK_TIME = /\b([01]?\d|2[0-3])[:.][0-5]\d\b/g;

/**
 * "17 сентября", "3 октября", "5 October" — a day number against a month name.
 *
 * Counting dates as well as times is what catches a roundup that gives each
 * entry a day but no hour. Tuned against the 966 messages one run had discarded
 * at detection: a times-only gate selected 118 of them and missed two real
 * digests in the very channel that prompted the step — one of them a Boiler Room
 * listing, so missing it cost exactly the music the step was built to recover.
 * Adding dates and venue markers took it to 196 of those 966 and caught both.
 *
 * In production on 2026-10-01 the gate admitted 366 of 2,536 cue-filtered
 * messages (14%), of which 134 were real digests yielding 1,032 events. So about
 * a third of what it admits is a digest and the remainder costs one call each to
 * rule out — the ratio the threshold is trading off.
 */
const DATE_WITH_MONTH =
  /\b\d{1,2}\s*(?:сентябр|октябр|ноябр|декабр|январ|феврал|март|апрел|ма[яй]|июн|июл|август|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/gi;

/** 📍 per venue, 🎟 per ticket price — a programme repeats them once per entry */
const ENTRY_MARKERS = [/📍/g, /🎟/g];

/** Opens one event's text in the model's answer: "4|event" */
const EVENT_MARKER = /^(\d+)\|event\s*$/i;

/** Declares a message to hold at most one event: "4|single" */
const SINGLE_MARKER = /^(\d+)\|single\s*$/i;

/**
 * A fragment's link, which has to be unique (it is the cache key for every later
 * step) and still open the post it came from. A URL fragment does both: Telegram
 * ignores `#2`, so the link lands on the digest the event was announced in.
 *
 * The suffix is an internal id and not for reading, so the reporters render it
 * through `postLink` instead, which strips it back off.
 */
function fragmentLink(parentLink: string, index: number): string {
  return `${parentLink}#${index + 1}`;
}

/** How many distinct matches a pattern has in the text. */
function distinctMatches(content: string, pattern: RegExp): number {
  const found = content.match(pattern);
  return found ? new Set(found.map((value) => value.toLowerCase())).size : 0;
}

/**
 * Whether a message is worth offering to the splitter at all.
 *
 * Any one signal reaching the threshold is enough — a programme repeats *some*
 * field once per entry, but which one varies: a day's agenda repeats times, a
 * month's roundup repeats dates, a venue list repeats pins. Requiring several
 * signals at once would reject each of those in turn.
 *
 * What still slips through is a roundup that enumerates events in prose, naming
 * neither times nor dates nor venues per entry. Those stay discarded at
 * detection, exactly as before this step existed.
 */
function looksLikeDigest(message: SourceMessage): boolean {
  const content = message.content;
  const signals = [
    distinctMatches(content, CLOCK_TIME),
    distinctMatches(content, DATE_WITH_MONTH),
    // Not distinct: the same marker repeated once per entry is the whole point
    ...ENTRY_MARKERS.map((marker) => (content.match(marker) ?? []).length),
  ];
  return signals.some((count) => count >= MIN_DIGEST_SIGNALS);
}

/** Builds the fragment messages a parent's split produced. */
function toFragments(parent: SourceMessage, texts: string[]): SourceMessage[] {
  return texts.map((content, idx) => ({
    timestamp: parent.timestamp,
    content,
    link: fragmentLink(parent.link, idx),
    source: parent.source,
  }));
}

/**
 * Parses the model's answer into per-message fragment texts.
 *
 * Returns a map from message number (1-based, as numbered in the prompt) to its
 * fragments. A message the model marked `single`, or never mentioned, is absent
 * from the map; the caller stores an empty split for it so it is not re-asked.
 */
function parseSplitResponse(
  result: string,
  chunkLength: number,
  onMalformed: (line: string) => void
): Map<number, string[]> {
  const fragments = new Map<number, string[]>();
  let current: { messageNum: number; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = current.lines.join('\n').trim();
    // A marker with nothing under it is not an event. Dropping it here keeps an
    // empty fragment from reaching detection and being judged on no content.
    if (text) {
      const existing = fragments.get(current.messageNum) ?? [];
      existing.push(text);
      fragments.set(current.messageNum, existing);
    }
    current = null;
  };

  for (const line of result.split('\n')) {
    const single = line.trim().match(SINGLE_MARKER);
    if (single) {
      flush();
      continue;
    }

    const event = line.trim().match(EVENT_MARKER);
    if (event) {
      flush();
      const messageNum = parseInt(event[1]);
      if (!Number.isInteger(messageNum) || messageNum < 1 || messageNum > chunkLength) {
        onMalformed(line);
        continue;
      }
      current = { messageNum, lines: [] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      // Prose outside any marker — a preamble the prompt asked for and did not get
      onMalformed(line);
    }
  }
  flush();

  return fragments;
}

/**
 * Step 3: turns a roundup post listing many events into one message per event.
 *
 * Detection (step 4) looks for a single event announcement and discards digests
 * by design, because one message means one event to every step after it — one
 * datetime, one venue, one cache entry. That is the right assumption for an
 * announcement and the wrong one for an afisha channel's day programme, which
 * is where concert and gig listings tend to live.
 *
 * Splitting here rather than relaxing detection keeps that assumption intact:
 * what leaves this step is still one event per message, and every later step is
 * untouched. A fragment carries its parent's timestamp and source, and a link of
 * `<parent>#<n>` — unique, so it keys the caches apart, and still a working link
 * back to the post.
 *
 * Messages that are not digests pass through unchanged, including those the
 * model was asked about and declined to split.
 */
export async function splitEventDigests(
  messages: SourceMessage[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugDigestSplittingEntry[],
  logger: Logger
): Promise<SourceMessage[]> {
  if (messages.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  if (!config.splitEventDigests) {
    logger.log(`  Digest splitting disabled, passing ${messages.length} messages through`);
    return messages;
  }

  logger.verbose(`  Processing cache...`);

  // link -> the fragments it splits into. Only non-empty entries matter; the
  // output is assembled from `messages` at the end, so input order is kept
  // without any bookkeeping about where a parent sat.
  const splits = new Map<string, string[]>();
  const candidates: SourceMessage[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    if (!looksLikeDigest(message)) {
      continue;
    }

    const cached = cache.getDigestSplitCache(message.link);
    if (cached === undefined) {
      candidates.push(message);
      continue;
    }

    cacheHits++;
    if (cached.length > 0) {
      splits.set(message.link, cached);
      logger.verbose(`    ✂ Split: ${message.link} - ${cached.length} events (cached)`);
    }
    debugEntries.push({
      messageLink: message.link,
      messageContent: message.content,
      isDigest: cached.length > 0,
      fragments: cached,
      cached: true,
    });
  }

  if (cacheHits > 0) {
    logger.verbose(`  Cache hits: ${cacheHits}/${cacheHits + candidates.length} candidates`);
  }

  const chunks = createBatches(candidates, config.digestSplittingBatchSize);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.verbose(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} candidates)...`);

    // The posting date goes in because a programme dates its entries relative to
    // it ("планы на четверг"), and each fragment has to carry an absolute date or
    // schedule extraction will read it against the wrong week.
    const messagesText = chunk
      .map((message, idx) => `${idx + 1}. [posted: ${message.timestamp.toDateString()}]\n${message.content}`)
      .join('\n\n---\n\n');

    const prompt = config.digestSplittingPrompt!.replace('{{MESSAGES}}', messagesText);

    let truncated = false;
    const result = await aiClient.call(prompt, {
      reasoningEffort: getStepReasoningEffort(config, 'digestSplitting'),
      onTruncated: () => {
        truncated = true;
      },
    });

    // A cut-off answer is discarded wholesale rather than used as far as it goes.
    // Two reasons, and the second is the dangerous one. The message the cut landed
    // in keeps only the events emitted before it. Worse, the messages numbered
    // after it were never answered at all, and an absent answer is read below as
    // "not a digest" — so a batch of three can bury two untouched digests under a
    // verdict the model never gave. Caching either outcome would make it
    // permanent: the key is link + model + effort + prompt, none of which change
    // on a rerun, so nothing would ever re-ask. Skipping the batch costs this
    // run's split and leaves the next one free to retry.
    if (truncated) {
      logger.log(
        `  ⚠ Batch ${i + 1}/${chunks.length} was cut off — skipping ${chunk.length} candidate(s) this run, ` +
          `nothing cached. Lower digestSplittingBatchSize (currently ${config.digestSplittingBatchSize}) if this repeats.`
      );
      for (const message of chunk) {
        debugEntries.push({
          messageLink: message.link,
          messageContent: message.content,
          isDigest: false,
          fragments: [],
          cached: false,
          truncated: true,
          prompt,
          aiResponse: result ?? '',
        });
      }
      continue;
    }

    const malformedLines: string[] = [];
    const parsed = result
      ? parseSplitResponse(result, chunk.length, (line) => malformedLines.push(line))
      : new Map<number, string[]>();

    if (malformedLines.length > 0) {
      logger.verbose(
        `    WARNING: AI returned unexpected format in lines: ${malformedLines.slice(0, 3).join(', ')}` +
          `${malformedLines.length > 3 ? ` (and ${malformedLines.length - 3} more)` : ''}`
      );
    }

    for (let idx = 0; idx < chunk.length; idx++) {
      const message = chunk[idx];
      const texts = parsed.get(idx + 1) ?? [];

      // One fragment is not a split: the model found a single event and restated
      // it, which would replace the announcement with a paraphrase of itself for
      // no gain. Cached as "not a digest" so it is not re-asked.
      const isDigest = texts.length > 1;
      const stored = isDigest ? texts : [];

      cache.cacheDigestSplit(message.link, stored, false);

      if (isDigest) {
        splits.set(message.link, texts);
        logger.verbose(`    ✂ Split: ${message.link} - ${texts.length} events`);
      }

      debugEntries.push({
        messageLink: message.link,
        messageContent: message.content,
        isDigest,
        fragments: stored,
        cached: false,
        prompt,
        aiResponse: result ?? '',
      });
    }

    cache.save();
  }

  // A split parent is replaced by its fragments where it stood; everything else
  // passes through untouched.
  const output: SourceMessage[] = [];
  let fragmentCount = 0;
  for (const message of messages) {
    const texts = splits.get(message.link);
    if (texts) {
      fragmentCount += texts.length;
      output.push(...toFragments(message, texts));
    } else {
      output.push(message);
    }
  }

  logger.log(`  Split ${splits.size} digests into ${fragmentCount} events (${output.length} messages total)`);
  return output;
}
