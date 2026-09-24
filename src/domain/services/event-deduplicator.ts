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

/**
 * Share of the *shorter* post's tokens that must appear in the longer one.
 *
 * A venue announcing the same concert twice does not repost verbatim: it
 * trims the blurb, drops a paragraph, swaps the ticket link. The second post
 * is then close to a subset of the first, which Jaccard punishes for the
 * length difference alone — a real repeat announcement measured 0.61 by
 * Jaccard but 0.88 by containment. Containment ignores what only the longer
 * post says, so it survives the trimming.
 */
const CONTENT_CONTAINMENT_THRESHOLD = 0.8;

/**
 * Containment only applies to posts with this many distinct tokens. Below it,
 * a handful of generic words ("концерт", "билеты", "Tbilisi") can sit inside
 * any longer announcement, so the symmetric measure stays in charge.
 */
const MIN_CONTAINMENT_TOKENS = 20;

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

function sharedTokens(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared;
}

/** Jaccard index: shared tokens over total distinct tokens. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  const shared = sharedTokens(a, b);
  return shared / (a.size + b.size - shared);
}

/** Overlap coefficient: shared tokens over the smaller set. */
function containment(a: Set<string>, b: Set<string>): number {
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return 0;

  return sharedTokens(a, b) / smaller;
}

/** Events are only compared within a calendar day. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

interface Candidate {
  event: DigestEvent;
  contentTokens: Set<string>;
}

/**
 * Two postings are the same event when one source post says nearly everything
 * the other does. For posts long enough to have an identity of their own that
 * is measured by containment, which tolerates a reworded or shortened repeat;
 * shorter posts fall back to Jaccard, where a length difference is evidence
 * rather than noise.
 */
function isDuplicate(a: Candidate, b: Candidate): boolean {
  const shorter = Math.min(a.contentTokens.size, b.contentTokens.size);

  if (shorter < MIN_CONTAINMENT_TOKENS) {
    return similarity(a.contentTokens, b.contentTokens) >= CONTENT_SIMILARITY_THRESHOLD;
  }
  return containment(a.contentTokens, b.contentTokens) >= CONTENT_CONTAINMENT_THRESHOLD;
}

/**
 * Step 7: collapses the same event announced by several sources into one entry.
 *
 * Runs before description so that duplicates never reach the describer, which is
 * the costliest AI step (one output block per event, batch size 3). The price is
 * that no normalised title exists yet, so the comparison is on the source posts
 * alone: cross-posts and reworded repeat announcements collapse, two independent
 * write-ups that share only the facts do not.
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
      // Matching any member, not just the primary, lets a chain of successive
      // rewrites stay one event: the third post can resemble the second
      // without still resembling the original announcement.
      const existing = clusters.find((cluster) =>
        [cluster.primary, ...cluster.duplicates].some((member) => isDuplicate(member, candidate))
      );
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

      // Every posting the cluster absorbed, including any the events being
      // merged had already absorbed, so the digest can list them all.
      const mergedSources = [
        ...(cluster.primary.event.duplicate_sources ?? []),
        ...cluster.duplicates.flatMap((d) => [d.event.message, ...(d.event.duplicate_sources ?? [])]),
      ];

      logger.verbose(
        `    ⧉ Merged ${cluster.duplicates.length} duplicate(s) into ${cluster.primary.event.message.link}: ` +
          mergedSources.map((m) => m.link).join(', ')
      );
      deduplicated.push({
        ...cluster.primary.event,
        duplicate_sources: mergedSources,
      });
    }
  }

  const result = [...deduplicated, ...undated];
  logger.log(`  Collapsed ${collapsed} duplicate(s) into ${result.length} distinct events`);
  return result;
}
