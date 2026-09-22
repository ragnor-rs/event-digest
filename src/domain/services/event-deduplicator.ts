import { Config } from '../../config/types';
import { Logger } from '../../shared/logger';
import { DigestEvent } from '../entities';

/**
 * Share of tokens two source posts must share to count as the same posting.
 * Aggregator channels copy announcements near-verbatim, so a genuine cross-post
 * looks almost identical. Kept strict even though it is the only signal here:
 * two different events at one venue share a lot of boilerplate, and a false
 * merge silently drops an event from the digest.
 */
const CONTENT_SIMILARITY_THRESHOLD = 0.8;

/** Tokens shorter than this are prepositions and noise, not event identity. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Reduces text to a comparable token set: lowercased, punctuation and emoji
 * stripped, short words dropped. Latin and Cyrillic are both kept.
 */
function tokenize(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

  return new Set(cleaned.split(/\s+/).filter((token) => token.length >= MIN_TOKEN_LENGTH));
}

/** Jaccard index: shared tokens over total distinct tokens. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/** Events are only compared within a calendar day. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

interface Candidate {
  event: DigestEvent;
  contentTokens: Set<string>;
}

/** Two postings are the same event when their source posts are near-identical. */
function isDuplicate(a: Candidate, b: Candidate): boolean {
  return similarity(a.contentTokens, b.contentTokens) >= CONTENT_SIMILARITY_THRESHOLD;
}

/**
 * Step 7: collapses the same event announced by several sources into one entry.
 *
 * Runs before description so that duplicates never reach the describer, which is
 * the costliest AI step (one output block per event, batch size 3). The price is
 * that no normalised title exists yet, so the comparison is on the source posts
 * alone: verbatim cross-posts collapse, independent write-ups of one event do not.
 *
 * Makes no AI calls, so it is neither cached nor rate-limited.
 *
 * The surviving copy is the earliest posting — the original announcement rather
 * than an aggregator's repost — and the others are kept on `duplicate_sources`
 * so no source link is lost.
 */
export async function deduplicateEvents(events: DigestEvent[], config: Config, logger: Logger): Promise<DigestEvent[]> {
  if (!config.deduplicateEvents) {
    logger.verbose('  Deduplication disabled, keeping all events');
    return events;
  }

  const byDay = new Map<string, Candidate[]>();
  const undated: DigestEvent[] = [];

  for (const event of events) {
    if (!event.start_datetime) {
      // No day to cluster within; pass through untouched rather than guess.
      undated.push(event);
      continue;
    }
    const key = dayKey(event.start_datetime);
    const candidate: Candidate = {
      event,
      contentTokens: tokenize(event.message.content),
    };
    byDay.set(key, [...(byDay.get(key) ?? []), candidate]);
  }

  const deduplicated: DigestEvent[] = [];
  let collapsed = 0;

  for (const candidates of byDay.values()) {
    // Earliest posting first, so the survivor of each cluster is the original.
    const ordered = [...candidates].sort(
      (a, b) => a.event.message.timestamp.getTime() - b.event.message.timestamp.getTime()
    );

    const clusters: { primary: Candidate; duplicates: Candidate[] }[] = [];
    for (const candidate of ordered) {
      const existing = clusters.find((cluster) => isDuplicate(cluster.primary, candidate));
      if (existing) {
        existing.duplicates.push(candidate);
        collapsed += 1;
      } else {
        clusters.push({ primary: candidate, duplicates: [] });
      }
    }

    for (const cluster of clusters) {
      if (cluster.duplicates.length === 0) {
        deduplicated.push(cluster.primary.event);
        continue;
      }

      logger.verbose(
        `    ⧉ Merged ${cluster.duplicates.length} duplicate(s) into ${cluster.primary.event.message.link}: ` +
          cluster.duplicates.map((d) => d.event.message.link).join(', ')
      );
      deduplicated.push({
        ...cluster.primary.event,
        duplicate_sources: cluster.duplicates.map((d) => d.event.message),
      });
    }
  }

  const result = [...deduplicated, ...undated];
  logger.log(`  Collapsed ${collapsed} duplicate(s) into ${result.length} distinct events`);
  return result;
}
