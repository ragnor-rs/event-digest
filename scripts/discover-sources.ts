/**
 * Finds candidate Telegram sources by mining a local Telegram export archive.
 *
 *   npx ts-node scripts/discover-sources.ts discover [--db=path] [--since=YYYY-MM-DD] [--limit=N]
 *   npx ts-node scripts/discover-sources.ts validate [--db=path] [--since=YYYY-MM-DD]
 *   npx ts-node scripts/discover-sources.ts yield
 *   npx ts-node scripts/discover-sources.ts add   [--dry-run] [--force]
 *   npx ts-node scripts/discover-sources.ts prune [--dry-run]
 *
 * `discover` — makes NO Telegram API calls and never writes config.yaml. It reads
 *              the archive and emits a ranked, evidence-backed candidate list to
 *              debug/discovered-sources.yaml for you to review and paste.
 * `validate` — scores the sources already in config.yaml with the same function
 *              and reports where they land. This catches a broken or inverted
 *              scorer, but it cannot certify a good one: config.yaml was built
 *              for topical interest, not event density, so "is configured" is a
 *              confounded label. Ground truth is `yield`, below.
 * `yield`    — no archive needed. Joins the pipeline caches to show how many
 *              events each configured source actually produced, so dead sources
 *              can be pruned. Discovery without pruning just grows the bill.
 * `add`      — the only command that writes config.yaml, and it writes ONLY what
 *              `expand-sources.ts verify` has resolved live. Existence, the
 *              channel-vs-group bucket and duplicate-under-another-label are all
 *              unknowable offline, so this command consumes those verdicts
 *              rather than forming its own. Edits are textual to preserve the
 *              file's comments, and config.yaml is backed up first because
 *              `config.yaml*` is gitignored and git cannot undo the edit.
 * `prune`    — the other end of the loop. Records a yield observation per run and
 *              comments out sources that produced nothing across several of them.
 *
 * The full loop: discover -> expand-sources.ts similar/folders/resolve ->
 * expand-sources.ts verify -> add -> pipeline run -> prune. See the
 * `source-discovery` skill for the runbook.
 *
 * Candidates come from three independent extractors:
 *   membership — chats in the archive that config.yaml does not monitor. These
 *                have local history, so they can be scored on real event density.
 *   forwards   — channels reaching you via forwarded messages (the forward graph).
 *   links      — t.me/<handle> references in message text.
 *
 * Only the membership pool has local history, so it is scored on how many of its
 * own messages are event announcements. External candidates have none and are
 * scored on reach plus the share of references to them that sit inside an event
 * announcement. The two pools are ranked and reported SEPARATELY — their scores
 * are not comparable.
 *
 * Coverage limit worth knowing before trusting the membership pool: a Telegram
 * export is mostly chats and groups. This archive holds 1,257 chats but only 16
 * channels, and none of the channels that actually produce the most events. So
 * `membership` sees groups well and channels barely at all — for channels, the
 * forward/link pools here and expand-sources.ts `similar` are the real routes.
 *
 * Privacy: the archive holds personal chats. Message text is read only to count
 * cues and extract links; output contains handles, counts and chat/message refs,
 * never message bodies.
 */

import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';
import yaml from 'js-yaml';

// TELEGRAM_ARCHIVE_DB lives in .env, so this has to load before openArchive
// reads it. Without it the variable is invisible here and only --db works.
dotenv.config();

import { DEFAULT_CONFIG } from '../src/config/defaults';

/**
 * node:sqlite ships with Node 22 but @types/node@20 has no declarations for it,
 * so it is required with a hand-written surface instead of imported.
 */
interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (filename: string, options?: { readOnly?: boolean }) => SqliteDb;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: SqliteCtor };

const OUTPUT_FILE = path.resolve(process.cwd(), 'debug/discovered-sources.yaml');
const EXPANDED_FILE = path.resolve(process.cwd(), 'debug/expanded-sources.yaml');
const CONFIG_FILE = path.resolve(process.cwd(), 'config.yaml');
const CACHE_DIR = path.resolve(process.cwd(), '.cache');

/**
 * Prune evidence. Lives in .cache/ rather than debug/ because it is state, not
 * an artifact: debug/ is cleared freely, and losing this file silently resets
 * every source's zero-yield history to nothing, which is indistinguishable from
 * every source being healthy. Treat it like resolved_entities.json — do not
 * delete it when clearing the GPT caches.
 */
const YIELD_HISTORY_FILE = path.join(CACHE_DIR, 'source_yield_history.json');

/**
 * How long a `verify` verdict is trusted. It asserts what is already monitored,
 * which config.yaml can invalidate at any time, so an old section describes a
 * config that no longer exists.
 */
const VERIFIED_MAX_AGE_HOURS = 72;

/**
 * Distinct pipeline runs a source must produce nothing across before it is
 * pruned. One run proves nothing: the window is a week and plenty of real
 * sources announce nothing in a given week.
 */
const MIN_DEAD_OBSERVATIONS = 3;

/**
 * Ceiling on how much of the config one prune may comment out, as a share of
 * configured sources.
 *
 * Silence is inferred from the ABSENCE of a cache entry, so anything that wipes
 * the evidence — a deleted telegram_messages.json, a stale identity map, a
 * history recorded against a different config — makes every source look dead at
 * once. A run that wants to remove half the config has almost certainly lost its
 * evidence rather than found fifty dead sources, and in an automatic flow there
 * is nobody watching to notice. Refusing is recoverable; a gutted config found
 * three digests later is not.
 */
const MAX_PRUNE_SHARE = 0.25;

/** Default lookback. Older references say more about where you used to live. */
const DEFAULT_SINCE_MONTHS = 12;

/** An event announcement is long, carries a clock time, and names a day. */
const MIN_ANNOUNCEMENT_CHARS = 200;

/**
 * Scoring weights. Subscores are normalised to 0..1 (geo to -1..1) before
 * weighting, so these are directly comparable within a pool.
 */
const W_VOLUME = 0.35; // membership: absolute event announcements in window
const W_DENSITY = 0.45; // membership: announcements per message, i.e. signal-to-noise
const W_FANIN = 0.3; // external: how many distinct chats reference it
const W_EVENT_CONTEXT = 0.3; // external: absolute references inside event announcements
const W_EVENT_RATE = 0.5; // external: share of references that are event-shaped
const W_RECENCY = 0.25;

/**
 * Geography is a gate, not a weight. Nearly every candidate in this archive
 * mentions Georgia, so scoring it adds a constant that discriminates nothing;
 * the only question worth asking is whether the source is in the wrong city.
 */

/** Saturation points — beyond these, more is not meaningfully better. */
const CAP_CUE_HITS = 60;
const CAP_FANIN = 8;
const CAP_EVENT_CONTEXT = 10;

/**
 * A link repeated 5,994 times is a pinned footer, not a recommendation. Rating
 * references by the share that sit inside event announcements separates a
 * channel people cite when organising things from one they cite constantly.
 */
const EVENT_RATE_PRIOR_MENTIONS = 5;

/** No reference inside an event announcement means no evidence of event content. */
const MIN_EVENT_CONTEXT = 1;

/**
 * Announcements per message at which a source counts as fully event-focused.
 * Without this, a 33k-message general chat where 0.2% of posts are events
 * outranks a small group that exists to announce them.
 */
const CAP_DENSITY = 0.05;

/**
 * Small-sample guard. Raw density lets a 10-message chat with one announcement
 * score 10% and outrank a real event channel, so density is smoothed toward
 * zero with a prior: a source has to clear this many messages before its rate
 * is believed.
 */
const DENSITY_PRIOR_MESSAGES = 200;

/** Below this many announcements in the window there is nothing to rank. */
const MIN_ANNOUNCEMENTS = 5;

/** Wrong city. Batumi and Moscow channels are event-dense and useless here. */
const GEO_REJECT_BELOW = -0.2;

/** Months after which a reference has decayed to ~37% of its weight. */
const RECENCY_DECAY_MONTHS = 6;

/** Batumi and Moscow channels rank high on event cues and are useless here. */
const GEO_POSITIVE = [
  'тбилиси',
  'tbilisi',
  'თბილისი',
  'грузи',
  'georgia',
  'საქართველო',
  'сабуртало',
  'saburtalo',
  'вake',
  'вера',
  'руставели',
  'rustaveli',
  'дидубе',
  'марджанишвили',
  'вакe',
  'vake',
];
const GEO_NEGATIVE = [
  'батуми',
  'batumi',
  'москв',
  'moscow',
  'санкт-петербург',
  'спб',
  'ереван',
  'yerevan',
  'кутаиси',
  'kutaisi',
  'алматы',
  'almaty',
  'белград',
  'belgrade',
];

/** t.me path segments that are never channel handles. */
const NON_HANDLE_SEGMENTS = new Set([
  'addlist',
  'joinchat',
  'share',
  'proxy',
  'iv',
  'socks',
  'login',
  'confirmphone',
  'setlanguage',
  'addstickers',
  'addemoji',
  'addtheme',
  'bg',
  'invoice',
  'giftcode',
  'c',
  's',
  'me',
  'telegram',
  'contest',
  'username',
]);

/** Chat types that cannot be configured as a group source. */
const NOT_ADDABLE_TYPES = new Set(['personal_chat', 'saved_messages']);

interface MembershipCandidate {
  name: string;
  chatType: string;
  totalMessages: number;
  /** Announcements per message — signal-to-noise, independent of chat size. */
  density: number;
  cueHits: number;
  lastSeen: string;
  geoPositive: number;
  geoNegative: number;
  score: number;
  addable: boolean;
}

interface ExternalCandidate {
  key: string;
  displayName: string;
  handle?: string;
  channelId?: string;
  origins: string[];
  fanIn: number;
  mentions: number;
  /**
   * References that appear inside an event announcement. Without this, the
   * ranking finds the most-recommended channels in Georgia (banks, accountants)
   * rather than the ones that carry events.
   */
  eventContext: number;
  lastSeen: string;
  geoPositive: number;
  geoNegative: number;
  score: number;
  evidence: string[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Builds an OR-chain of case-insensitive substring tests, evaluated in SQLite. */
function anyLike(column: string, terms: string[]): string {
  if (terms.length === 0) return '0';
  return '(' + terms.map((t) => `instr(lower(${column}), '${sqlQuote(t.toLowerCase())}') > 0`).join(' OR ') + ')';
}

/** Mirrors the production event-cue prefilter, tightened with length and a clock time. */
function announcementPredicate(column: string): string {
  const cues = Object.values(DEFAULT_CONFIG.eventMessageCues).flat() as string[];
  const clock = `(${column} GLOB '*[0-9][0-9]:[0-9][0-9]*' OR ${column} GLOB '*[0-9]:[0-9][0-9]*')`;
  return `(length(${column}) > ${MIN_ANNOUNCEMENT_CHARS} AND ${clock} AND ${anyLike(column, cues)})`;
}

function normalise(value: number, cap: number): number {
  return Math.min(value, cap) / cap;
}

function recencyScore(lastSeen: string, now: Date): number {
  const then = new Date(lastSeen);
  if (Number.isNaN(then.getTime())) return 0;
  const months = (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.exp(-Math.max(0, months) / RECENCY_DECAY_MONTHS);
}

/** -1 (wrong city) .. +1 (clearly Tbilisi). Zero when there is no geo signal. */
function geoScore(positive: number, negative: number): number {
  const total = positive + negative;
  if (total === 0) return 0;
  return (positive - negative) / total;
}

/** "Paper Kartuli" and "paperkartuli" are the same source wearing two labels. */
function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * Accepts both `--key=value` and a bare `--key`. The bare form matters because
 * the natural thing to type is `--dry-run`, and a parser that recognised only
 * the `=` form dropped it silently — leaving a guard that read as "off" and a
 * command that wrote the file it had just promised not to touch.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    const pair = /^--([^=]+)=(.*)$/.exec(arg);
    if (pair) {
      flags[pair[1]] = pair[2];
      continue;
    }
    const bare = /^--([^=]+)$/.exec(arg);
    if (bare) flags[bare[1]] = 'true';
  }
  return flags;
}

/** `--flag`, `--flag=true` are on; absent, `--flag=false` and `--flag=0` are off. */
function isFlagSet(flags: Record<string, string>, name: string): boolean {
  const value = flags[name];
  return value !== undefined && value !== 'false' && value !== '0';
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

interface ConfiguredSources {
  handles: Set<string>;
  displayNames: string[];
  all: string[];
}

function loadConfiguredSources(): ConfiguredSources {
  const raw = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf-8')) as {
    channelsToParse?: string[];
    groupsToParse?: string[];
  };
  const all = [...(raw.channelsToParse ?? []), ...(raw.groupsToParse ?? [])];

  const handles = new Set<string>();
  const displayNames: string[] = [];
  for (const source of all) {
    if (source.startsWith('@')) handles.add(normaliseKey(source.slice(1)));
    else displayNames.push(source.toLowerCase());
  }
  return { handles, displayNames, all };
}

/**
 * Decides whether an archive chat is already monitored. Display names use the
 * same substring rule as TelegramClient.findEntityByDisplayName, so "already
 * monitored" means offline exactly what it means at runtime.
 *
 * Known false negatives: a configured @handle whose channel has a different
 * display name is not recognised — "@unicornembassy_georgia" does not match the
 * chat "Unicorn Embassy | Tbilisi", so it surfaces as a candidate. Deliberate:
 * a fuzzy matcher aggressive enough to catch these also hides real candidates
 * ("tbilisiclub" vs "TbilisiCoffeeClubChannel"), and a duplicate in the output
 * costs a glance while a false exclusion is invisible.
 */
function isMonitored(chatName: string, configured: ConfiguredSources): boolean {
  const lower = chatName.toLowerCase();
  if (configured.displayNames.some((name) => lower.includes(name))) return true;
  return configured.handles.has(normaliseKey(chatName));
}

// ---------------------------------------------------------------------------
// extractors
// ---------------------------------------------------------------------------

function extractMembership(db: SqliteDb, since: string, configured: ConfiguredSources): MembershipCandidate[] {
  const rows = db
    .prepare(
      `
    SELECT c.name AS name,
           c.type AS type,
           COUNT(*) AS total,
           SUM(CASE WHEN ${announcementPredicate('m.text')} THEN 1 ELSE 0 END) AS cueHits,
           MAX(m.date) AS lastSeen,
           SUM(CASE WHEN ${anyLike('m.text', GEO_POSITIVE)} THEN 1 ELSE 0 END) AS geoPos,
           SUM(CASE WHEN ${anyLike('m.text', GEO_NEGATIVE)} THEN 1 ELSE 0 END) AS geoNeg
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE m.date >= '${sqlQuote(since)}' AND m.text IS NOT NULL AND c.name IS NOT NULL
    GROUP BY c.id
    HAVING cueHits >= ${MIN_ANNOUNCEMENTS}
  `
    )
    .all();

  const now = new Date();
  return rows
    .map((row) => {
      const name = String(row.name);
      const cueHits = Number(row.cueHits);
      const geoPos = Number(row.geoPos);
      const geoNeg = Number(row.geoNeg);
      const lastSeen = String(row.lastSeen);
      const chatType = String(row.type);
      const totalMessages = Number(row.total);
      const density = cueHits / (totalMessages + DENSITY_PRIOR_MESSAGES);
      const score =
        W_VOLUME * normalise(cueHits, CAP_CUE_HITS) +
        W_DENSITY * normalise(density, CAP_DENSITY) +
        W_RECENCY * recencyScore(lastSeen, now);
      return {
        name,
        chatType,
        totalMessages,
        density,
        cueHits,
        lastSeen: lastSeen.slice(0, 10),
        geoPositive: geoPos,
        geoNegative: geoNeg,
        score,
        addable: !NOT_ADDABLE_TYPES.has(chatType),
        monitored: isMonitored(name, configured),
      };
    })
    .filter((c) => !c.monitored)
    .sort((a, b) => b.score - a.score);
}

function extractForwards(db: SqliteDb, since: string): ExternalCandidate[] {
  const rows = db
    .prepare(
      `
    SELECT m.forwarded_from AS name,
           m.forwarded_from_id AS fid,
           COUNT(*) AS mentions,
           COUNT(DISTINCT m.chat_id) AS fanIn,
           MAX(m.date) AS lastSeen,
           SUM(CASE WHEN ${announcementPredicate('m.text')} THEN 1 ELSE 0 END) AS eventContext,
           SUM(CASE WHEN ${anyLike('m.text', GEO_POSITIVE)} THEN 1 ELSE 0 END) AS geoPos,
           SUM(CASE WHEN ${anyLike('m.text', GEO_NEGATIVE)} THEN 1 ELSE 0 END) AS geoNeg
    FROM messages m
    WHERE m.is_forwarded = 1
      AND m.forwarded_from_id LIKE 'channel%'
      AND m.forwarded_from IS NOT NULL
      AND m.date >= '${sqlQuote(since)}'
    GROUP BY m.forwarded_from_id
  `
    )
    .all();

  return rows.map((row) => {
    const displayName = String(row.name);
    return {
      key: normaliseKey(displayName),
      displayName,
      channelId: String(row.fid).replace('channel', ''),
      origins: ['forward'],
      fanIn: Number(row.fanIn),
      mentions: Number(row.mentions),
      eventContext: Number(row.eventContext),
      lastSeen: String(row.lastSeen).slice(0, 10),
      geoPositive: Number(row.geoPos),
      geoNegative: Number(row.geoNeg),
      score: 0,
      evidence: [] as string[],
    };
  });
}

function extractLinks(db: SqliteDb, since: string): ExternalCandidate[] {
  const rows = db
    .prepare(
      `
    SELECT m.text AS text, m.chat_id AS chatId, m.message_id AS messageId,
           m.date AS date, c.name AS chatName,
           ${announcementPredicate('m.text')} AS isEvent
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE m.text LIKE '%t.me/%' AND m.date >= '${sqlQuote(since)}'
  `
    )
    .all();

  const byHandle = new Map<string, ExternalCandidate & { chats: Set<number> }>();

  for (const row of rows) {
    const text = String(row.text);
    const chatId = Number(row.chatId);
    const chatName = String(row.chatName ?? 'unknown');
    const date = String(row.date);

    const handles = new Set<string>();
    for (const match of text.matchAll(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})/g)) {
      const handle = match[1].toLowerCase();
      if (NON_HANDLE_SEGMENTS.has(handle) || handle.endsWith('bot')) continue;
      handles.add(handle);
    }

    const geoPos = GEO_POSITIVE.some((t) => text.toLowerCase().includes(t)) ? 1 : 0;
    const geoNeg = GEO_NEGATIVE.some((t) => text.toLowerCase().includes(t)) ? 1 : 0;
    const isEvent = Number(row.isEvent) === 1 ? 1 : 0;

    for (const handle of handles) {
      let entry = byHandle.get(handle);
      if (!entry) {
        entry = {
          key: normaliseKey(handle),
          displayName: handle,
          handle,
          origins: ['link'],
          fanIn: 0,
          mentions: 0,
          eventContext: 0,
          lastSeen: date,
          geoPositive: 0,
          geoNegative: 0,
          score: 0,
          evidence: [],
          chats: new Set<number>(),
        };
        byHandle.set(handle, entry);
      }
      entry.mentions += 1;
      entry.eventContext += isEvent;
      entry.chats.add(chatId);
      entry.geoPositive += geoPos;
      entry.geoNegative += geoNeg;
      if (date > entry.lastSeen) entry.lastSeen = date;
      if (entry.evidence.length < 3) {
        entry.evidence.push(`${chatName} #${row.messageId} (${date.slice(0, 10)})`);
      }
    }
  }

  return [...byHandle.values()].map((entry) => ({
    key: entry.key,
    displayName: entry.displayName,
    handle: entry.handle,
    origins: entry.origins,
    fanIn: entry.chats.size,
    mentions: entry.mentions,
    eventContext: entry.eventContext,
    lastSeen: entry.lastSeen.slice(0, 10),
    geoPositive: entry.geoPositive,
    geoNegative: entry.geoNegative,
    score: 0,
    evidence: entry.evidence,
  }));
}

/** Folder and invite links, collected for the live expansion pass (phase C). */
function extractBundles(db: SqliteDb, since: string): { addlist: string[]; invite: string[] } {
  const rows = db
    .prepare(
      `
    SELECT text FROM messages
    WHERE (text LIKE '%t.me/addlist/%' OR text LIKE '%t.me/+%' OR text LIKE '%t.me/joinchat/%')
      AND date >= '${sqlQuote(since)}'
  `
    )
    .all();

  const addlist = new Set<string>();
  const invite = new Set<string>();
  for (const row of rows) {
    const text = String(row.text);
    for (const m of text.matchAll(/t\.me\/addlist\/([A-Za-z0-9_-]+)/g)) addlist.add(m[1]);
    for (const m of text.matchAll(/t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)/g)) invite.add(m[1]);
  }
  return { addlist: [...addlist], invite: [...invite] };
}

/** Merges the forward and link pools, keyed on a normalised name, then scores. */
function mergeExternal(
  forwards: ExternalCandidate[],
  links: ExternalCandidate[],
  configured: ConfiguredSources
): ExternalCandidate[] {
  const merged = new Map<string, ExternalCandidate>();

  for (const candidate of [...forwards, ...links]) {
    const existing = merged.get(candidate.key);
    if (!existing) {
      merged.set(candidate.key, { ...candidate });
      continue;
    }
    existing.fanIn = Math.max(existing.fanIn, candidate.fanIn);
    existing.mentions += candidate.mentions;
    existing.eventContext += candidate.eventContext;
    existing.geoPositive += candidate.geoPositive;
    existing.geoNegative += candidate.geoNegative;
    existing.handle = existing.handle ?? candidate.handle;
    existing.channelId = existing.channelId ?? candidate.channelId;
    existing.origins = [...new Set([...existing.origins, ...candidate.origins])];
    if (candidate.lastSeen > existing.lastSeen) existing.lastSeen = candidate.lastSeen;
    if (existing.evidence.length < 3) {
      existing.evidence.push(...candidate.evidence.slice(0, 3 - existing.evidence.length));
    }
  }

  const now = new Date();
  const unmonitored = [...merged.values()].filter(
    (c) => !configured.handles.has(c.key) && !isMonitored(c.displayName, configured)
  );
  const withEventContext = unmonitored.filter((c) => c.eventContext >= MIN_EVENT_CONTEXT);
  console.log(
    `  external: ${unmonitored.length} unmonitored refs, ${withEventContext.length} ever cited ` +
      `inside an event announcement (${unmonitored.length - withEventContext.length} dropped)`
  );

  return withEventContext
    .map((c) => ({
      ...c,
      score:
        W_FANIN * normalise(c.fanIn, CAP_FANIN) +
        W_EVENT_CONTEXT * normalise(c.eventContext, CAP_EVENT_CONTEXT) +
        W_EVENT_RATE * (c.eventContext / (c.mentions + EVENT_RATE_PRIOR_MENTIONS)) +
        W_RECENCY * recencyScore(c.lastSeen, now),
    }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * The archive path has no default. An export lives wherever its owner put it,
 * usually outside this repo, so any default would be one machine's layout
 * baked into a shared file — and `discover` failing with "set
 * TELEGRAM_ARCHIVE_DB" is a better first run than it silently finding nothing
 * at a path that means something only to whoever committed it.
 *
 * See scripts/export-telegram.ts for producing the export this reads.
 */
function openArchive(flags: Record<string, string>): SqliteDb {
  const dbPath = flags.db ?? process.env.TELEGRAM_ARCHIVE_DB;
  if (!dbPath) {
    throw new Error(
      'No Telegram archive configured. Set TELEGRAM_ARCHIVE_DB in .env or pass --db=<path>.\n' +
        'To create an archive, run: npx ts-node scripts/export-telegram.ts'
    );
  }
  const resolved = path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Archive not found at ${resolved}. Check TELEGRAM_ARCHIVE_DB or --db=<path>.\n` +
        'To create an archive, run: npx ts-node scripts/export-telegram.ts'
    );
  }
  return new DatabaseSync(resolved, { readOnly: true });
}

function discover(flags: Record<string, string>): void {
  const since = flags.since ?? monthsAgoIso(DEFAULT_SINCE_MONTHS);
  const limit = flags.limit ? parseInt(flags.limit, 10) : 25;
  const configured = loadConfiguredSources();
  const db = openArchive(flags);

  console.log(`Mining archive since ${since} (${configured.all.length} sources already configured)\n`);

  const membershipAll = extractMembership(db, since, configured);
  const externalAll = mergeExternal(extractForwards(db, since), extractLinks(db, since), configured);
  const bundles = extractBundles(db, since);
  db.close();

  const rightCity = (c: { geoPositive: number; geoNegative: number }): boolean =>
    geoScore(c.geoPositive, c.geoNegative) >= GEO_REJECT_BELOW;

  const wrongCityMembership = membershipAll.filter((c) => !rightCity(c));
  const wrongCityExternal = externalAll.filter((c) => !rightCity(c));
  const membership = membershipAll.filter(rightCity).filter((c) => c.addable);
  const notAddable = membershipAll.filter(rightCity).filter((c) => !c.addable);
  const external = externalAll.filter(rightCity);

  const topMembership = membership.slice(0, limit);
  const topExternal = external.slice(0, limit);

  console.log(`JOINED BUT NOT MONITORED — ${membership.length} candidates, top ${topMembership.length}`);
  console.log('  score  announce   msgs  density   geo  type                 name');
  for (const c of topMembership) {
    const geo = geoScore(c.geoPositive, c.geoNegative).toFixed(2).padStart(5);
    const density = (c.density * 100).toFixed(1).padStart(6) + '%';
    console.log(
      `  ${c.score.toFixed(3)}  ${String(c.cueHits).padStart(8)}  ${String(c.totalMessages).padStart(5)}  ` +
        `${density}  ${geo}  ${c.chatType.padEnd(19)} ${c.name}${c.addable ? '' : '  [not addable as group]'}`
    );
  }

  console.log(`\nEXTERNAL REFERENCES — ${external.length} candidates, top ${topExternal.length}`);
  console.log('  score  fanIn  mentions  in-event   geo  origins        name');
  for (const c of topExternal) {
    const geo = geoScore(c.geoPositive, c.geoNegative).toFixed(2).padStart(5);
    console.log(
      `  ${c.score.toFixed(3)}  ${String(c.fanIn).padStart(5)}  ${String(c.mentions).padStart(8)}  ` +
        `${String(c.eventContext).padStart(8)}  ${geo}  ` +
        `${c.origins.join('+').padEnd(13)} ${c.handle ? '@' + c.handle : c.displayName}`
    );
  }

  if (notAddable.length > 0) {
    console.log(`\nEVENT-DENSE BUT NOT ADDABLE AS A GROUP — ${notAddable.length}`);
    for (const c of notAddable.slice(0, 5)) {
      console.log(`  ${c.score.toFixed(3)}  ${c.chatType.padEnd(14)} ${c.name} (${c.cueHits} announcements)`);
    }
    console.log('  These are DMs or saved messages. Follow the channel behind them instead.');
  }

  // Reporting what was dropped, so a filtered-out candidate is a decision you
  // can see rather than a gap you cannot.
  console.log(
    `\nDROPPED — ${wrongCityMembership.length} chats and ${wrongCityExternal.length} external refs ` +
      `scored below ${GEO_REJECT_BELOW} on geography (Batumi/Moscow/etc).`
  );
  console.log(`BUNDLES for phase C — ${bundles.addlist.length} folder links, ${bundles.invite.length} invite links`);

  const report = {
    generated_since: since,
    note:
      'Scores are only comparable WITHIN a section. Membership candidates are scored on ' +
      'real local history; external candidates have none and are scored on reach alone.',
    joined_but_not_monitored: topMembership.map((c) => ({
      name: c.name,
      type: c.chatType,
      score: Number(c.score.toFixed(3)),
      event_announcements: c.cueHits,
      total_messages: c.totalMessages,
      density_pct: Number((c.density * 100).toFixed(2)),
      last_seen: c.lastSeen,
      geo: Number(geoScore(c.geoPositive, c.geoNegative).toFixed(2)),
      addable_as_group: c.addable,
    })),
    external_references: topExternal.map((c) => ({
      name: c.handle ? `@${c.handle}` : c.displayName,
      channel_id: c.channelId,
      score: Number(c.score.toFixed(3)),
      fan_in: c.fanIn,
      mentions: c.mentions,
      mentions_in_event_context: c.eventContext,
      last_seen: c.lastSeen,
      geo: Number(geoScore(c.geoPositive, c.geoNegative).toFixed(2)),
      origins: c.origins,
      evidence: c.evidence,
    })),
    event_dense_but_not_addable: notAddable.slice(0, 5).map((c) => ({
      name: c.name,
      type: c.chatType,
      event_announcements: c.cueHits,
    })),
    dropped_wrong_geography: {
      chats: wrongCityMembership.length,
      external_refs: wrongCityExternal.length,
    },
    bundles_for_live_expansion: bundles,
    paste_ready: {
      channelsToParse: topExternal.filter((c) => c.handle).map((c) => `@${c.handle}`),
      groupsToParse: topMembership.map((c) => c.name),
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, yaml.dump(report, { lineWidth: 120 }));
  console.log(`\nWrote ${OUTPUT_FILE}`);
  console.log('Review before pasting — this script never edits config.yaml.');
}

/**
 * Sanity check on the scorer: configured sources are known-good, so they should
 * rank high among all archive chats. If they do not, the weights are wrong.
 */
function validate(flags: Record<string, string>): void {
  const since = flags.since ?? monthsAgoIso(DEFAULT_SINCE_MONTHS);
  const configured = loadConfiguredSources();
  const db = openArchive(flags);

  // Score every chat, monitored or not, so configured sources can be placed.
  const empty: ConfiguredSources = { handles: new Set(), displayNames: [], all: [] };
  const all = extractMembership(db, since, empty)
    .filter((c) => geoScore(c.geoPositive, c.geoNegative) >= GEO_REJECT_BELOW)
    .filter((c) => c.addable);
  db.close();

  const ranked = all.map((c, index) => ({ ...c, rank: index + 1 }));
  const monitored = ranked.filter((c) => isMonitored(c.name, configured));

  console.log(`Scored ${ranked.length} archive chats with event cues since ${since}.`);
  console.log(`${monitored.length} of them are already in config.yaml.\n`);
  console.log('  rank/total  score  announce  name');
  for (const c of monitored) {
    console.log(
      `  ${String(c.rank).padStart(4)}/${ranked.length}  ${c.score.toFixed(3)}  ` +
        `${String(c.cueHits).padStart(8)}  ${c.name}`
    );
  }

  if (monitored.length === 0) {
    console.log('\nNo configured source matched an archive chat — cannot validate.');
    return;
  }
  const medianRank = monitored.map((c) => c.rank).sort((a, b) => a - b)[Math.floor(monitored.length / 2)];
  const percentile = (1 - medianRank / ranked.length) * 100;
  console.log(
    `\nMedian rank of an already-configured source: ${medianRank}/${ranked.length} ` +
      `(top ${percentile.toFixed(0)}%). Random would be 50%.`
  );

  if (percentile < 35) {
    console.log(
      'Configured sources rank BELOW chance. The scorer is likely inverted or broken — ' +
        'do not trust discover output.'
    );
    return;
  }

  // Being near chance is the expected outcome, not a passing grade: config.yaml
  // was assembled for topical interest, and several of its groups genuinely do
  // carry few announcements. This check can only catch a badly broken scorer.
  console.log(
    percentile >= 65
      ? 'Configured sources cluster above chance — the scorer tracks something real.'
      : 'Configured sources sit near chance. That is weak evidence either way: membership in\n' +
          'config.yaml reflects topical interest, not event density, so it is a confounded label.'
  );
  console.log(
    '\nGround truth is events actually produced, not archive cues. Run `yield` after a\n' +
      'pipeline run and compare: a source ranked high here that yields nothing there means\n' +
      'these weights are measuring the wrong thing.'
  );
}

interface YieldRow {
  source: string;
  messages: number;
  events: number;
  per100: number;
}

/**
 * Joins the message and event caches into a per-source count. Shared by `yield`
 * (which reports it) and `prune` (which accumulates it across runs), so both
 * always mean the same thing by "yield".
 */
function computeYield(): YieldRow[] {
  const messagesPath = path.join(CACHE_DIR, 'telegram_messages.json');
  const eventsPath = path.join(CACHE_DIR, 'events.json');
  if (!fs.existsSync(messagesPath) || !fs.existsSync(eventsPath)) {
    throw new Error(`Need ${messagesPath} and ${eventsPath}. Run the pipeline first.`);
  }

  const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf-8')) as Record<string, unknown[]>;
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf-8')) as Record<string, unknown>;

  /** Cache keys are `<type>:<source>:<limit>`; private groups use a `c/<id>` source. */
  const sourceOf = (cacheKey: string): string => cacheKey.split(':').slice(1, -1).join(':');

  /** Event keys start with the message permalink, so the source is in the path. */
  const sourceOfLink = (eventKey: string): string => {
    const link = eventKey.split('|')[0];
    const parts = link.replace('https://t.me/', '').split('/');
    return parts[0] === 'c' ? `c/${parts[1]}` : parts[0];
  };

  const counts = new Map<string, { messages: number; events: number }>();
  for (const [key, list] of Object.entries(messages)) {
    const source = sourceOf(key);
    const entry = counts.get(source) ?? { messages: 0, events: 0 };
    entry.messages += (list ?? []).length;
    counts.set(source, entry);
  }
  for (const key of Object.keys(events)) {
    const source = sourceOfLink(key);
    const entry = counts.get(source) ?? { messages: 0, events: 0 };
    entry.events += 1;
    counts.set(source, entry);
  }

  return [...counts.entries()]
    .map(([source, c]) => ({
      source,
      ...c,
      per100: c.messages > 0 ? (c.events / c.messages) * 100 : 0,
    }))
    .sort((a, b) => b.per100 - a.per100 || b.events - a.events);
}

/**
 * Per-source yield from the pipeline caches. A source that never produces a
 * surviving event still costs GPT tokens and Telegram calls on every run.
 */
function yieldAudit(): void {
  const rows = computeYield();

  console.log('Per-source yield from the current caches.\n');
  console.log('  events  msgs   per100  source');
  for (const row of rows) {
    console.log(
      `  ${String(row.events).padStart(6)}  ${String(row.messages).padStart(5)}  ` +
        `${row.per100.toFixed(2).padStart(6)}  ${row.source}`
    );
  }

  const dead = rows.filter((r) => r.events === 0);
  console.log(`\n${dead.length}/${rows.length} sources produced zero events in the current cache.`);
  if (dead.length > 0) {
    console.log('Zero-yield sources: ' + dead.map((r) => r.source).join(', '));
    console.log(
      'Caveat: the cache reflects one interest set and one run window. Confirm across ' + 'several runs before pruning.'
    );
  }
}

// ---------------------------------------------------------------------------
// config.yaml editing — shared by add and prune
// ---------------------------------------------------------------------------

function isoStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * config.yaml is gitignored (`config.yaml*`), so git cannot undo an edit here
 * and a backup is the only way back. The backup pattern is covered by that same
 * ignore rule, so it never reaches the repo.
 */
function backupConfig(): string {
  const destination = `${CONFIG_FILE}.bak-${isoStamp()}`;
  fs.copyFileSync(CONFIG_FILE, destination);
  return destination;
}

/**
 * Index just past the last line of `key`'s list block.
 *
 * The edit is textual, not a js-yaml round trip, because config.yaml is mostly
 * comments — the interest taxonomy, the batch-size rationale, the provenance
 * notes this command itself writes — and dumping a parsed document back out
 * would delete every one of them without a word.
 *
 * An INDENTED comment belongs to the list (the disabled-sources block at the
 * end of groupsToParse); a column-0 comment is the header of the next key and
 * stops the scan, so insertion never wedges itself between a comment block and
 * the key it documents.
 */
function findListBlockEnd(lines: string[], key: string): number {
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (start === -1) throw new Error(`No ${key}: block in ${CONFIG_FILE}`);

  let lastContent = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    if (/^\s+#/.test(line) || /^\s*-\s/.test(line)) {
      lastContent = i;
      continue;
    }
    break;
  }
  return lastContent + 1;
}

/** Comments a configured source out in place, in the style already in the file. */
function commentOutEntry(lines: string[], entry: string, reason: string): boolean {
  const index = lines.findIndex((line) => {
    if (/^\s*#/.test(line)) return false;
    const match = /^(\s*)-\s+(.*)$/.exec(line);
    if (!match) return false;
    const value = match[2]
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^["']|["']$/g, '');
    return value === entry;
  });
  if (index === -1) return false;

  const indent = /^(\s*)/.exec(lines[index])?.[1] ?? '  ';
  lines[index] = `${indent}# ${lines[index].trim()}  # pruned ${todayIso()}: ${reason}`;
  return true;
}

function loadExpandedSection<T>(section: string): T | undefined {
  if (!fs.existsSync(EXPANDED_FILE)) return undefined;
  const report = (yaml.load(fs.readFileSync(EXPANDED_FILE, 'utf-8')) ?? {}) as Record<string, unknown>;
  return report[section] as T | undefined;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

interface VerifiedEntry {
  handle: string;
  bucket: string;
  title?: string;
  kind?: string;
  participants?: number;
  origins?: string[];
}

/**
 * Writes verified candidates into config.yaml. Deliberately does no judging of
 * its own: every check that matters — existence, channel-vs-group, duplicate
 * under another label — needs a live resolve, so this consumes
 * `expand-sources.ts verify` rather than second-guessing it. An unverified
 * handle is never written.
 */
function add(flags: Record<string, string>): void {
  const verified = loadExpandedSection<{ generated?: string; addable?: VerifiedEntry[] }>('verified');
  if (!verified) {
    throw new Error(`No verified section in ${EXPANDED_FILE}. Run: expand-sources.ts verify`);
  }

  const generated = verified.generated ? new Date(verified.generated) : undefined;
  const ageHours = generated ? (Date.now() - generated.getTime()) / 3_600_000 : Infinity;
  if (ageHours > VERIFIED_MAX_AGE_HOURS && !isFlagSet(flags, 'force')) {
    const age = Number.isFinite(ageHours) ? `${Math.round(ageHours)}h old` : 'undated';
    throw new Error(
      `The verified section is ${age} (max ${VERIFIED_MAX_AGE_HOURS}h). It asserts what is already ` +
        'monitored, which config.yaml can invalidate at any time. Re-run expand-sources.ts verify, ' +
        'or pass --force.'
    );
  }

  const addable = verified.addable ?? [];
  if (addable.length === 0) {
    console.log('Nothing verified as addable — config.yaml unchanged.');
    return;
  }

  let lines = fs.readFileSync(CONFIG_FILE, 'utf-8').split('\n');
  const configText = lines.join('\n').toLowerCase();

  /**
   * Idempotency, and the last line of defence against a stale verified section:
   * a handle already written is never written twice, whatever the report says.
   *
   * Bounded on the right, because a plain substring test makes every handle that
   * is a prefix of a configured one look present — `@quiz_tbi` would read as
   * already there because `@quiz_tbi_extra` is, and the source would be dropped
   * silently. Telegram handles are `[A-Za-z0-9_]`, so anything else ends one.
   */
  const alreadyPresent = (handle: string): boolean =>
    new RegExp(`${handle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).test(configText);

  /**
   * A handle that appears only on a commented-out line was pruned deliberately.
   * Skipping it is correct — re-adding what prune just removed would loop — but
   * it has to be reported as its own case, not folded into "already present",
   * or a source that keeps being rediscovered looks like a no-op every time.
   */
  const isPruned = (handle: string): boolean =>
    lines.some((line) => /^\s*#/.test(line) && line.toLowerCase().includes(handle.toLowerCase()));

  const fresh = addable.filter((entry) => !alreadyPresent(entry.handle));
  const skipped = addable.filter((entry) => alreadyPresent(entry.handle) && !isPruned(entry.handle));
  const skippedAsPruned = addable.filter((entry) => alreadyPresent(entry.handle) && isPruned(entry.handle));

  if (fresh.length === 0) {
    console.log(
      `All ${addable.length} verified sources are already in config.yaml — unchanged.` +
        (skippedAsPruned.length > 0
          ? `\n${skippedAsPruned.length} of them sit on a commented-out (pruned) line: ` +
            `${skippedAsPruned.map((e) => e.handle).join(', ')}`
          : '')
    );
    return;
  }

  const buckets: Record<string, VerifiedEntry[]> = {};
  for (const entry of fresh) {
    const bucket = entry.bucket === 'channelsToParse' ? 'channelsToParse' : 'groupsToParse';
    (buckets[bucket] ??= []).push(entry);
  }

  const renderBlock = (entries: VerifiedEntry[]): string[] => [
    '',
    `  # Added ${todayIso()} by expand-sources.ts verify -> discover-sources.ts add.`,
    '  # Untested — run `discover-sources.ts yield` after a few digests, then `prune`.',
    ...entries.map((entry) => {
      const facts = [entry.title, entry.kind, entry.participants ? `${entry.participants} members` : undefined]
        .filter(Boolean)
        .join(' · ');
      const via = entry.origins?.length ? ` · via ${entry.origins.join('+')}` : '';
      return `  - "${entry.handle}"${facts || via ? `  # ${facts}${via}` : ''}`;
    }),
  ];

  if (isFlagSet(flags, 'dry-run')) {
    console.log('--dry-run — config.yaml not touched. Would insert:\n');
    for (const [bucket, entries] of Object.entries(buckets)) {
      console.log(`${bucket}:`);
      console.log(renderBlock(entries).join('\n'));
    }
    return;
  }

  const backup = backupConfig();
  // One bucket at a time: each splice shifts every later line, so the insertion
  // point for the second bucket is only correct once the first is in place.
  for (const [bucket, entries] of Object.entries(buckets)) {
    const at = findListBlockEnd(lines, bucket);
    lines = [...lines.slice(0, at), ...renderBlock(entries), ...lines.slice(at)];
  }
  fs.writeFileSync(CONFIG_FILE, lines.join('\n'));

  console.log(`Backed up to ${path.basename(backup)}`);
  for (const [bucket, entries] of Object.entries(buckets)) {
    console.log(`Added to ${bucket}: ${entries.map((e) => e.handle).join(', ')}`);
  }
  if (skipped.length > 0) {
    console.log(`Already present, skipped: ${skipped.map((e) => e.handle).join(', ')}`);
  }
  if (skippedAsPruned.length > 0) {
    console.log(
      `Previously pruned, NOT re-added: ${skippedAsPruned.map((e) => e.handle).join(', ')}\n` +
        '  Uncomment the line by hand if you want it back — discovery keeps re-finding these.'
    );
  }
  console.log(
    '\nEach new source starts with an empty cache, so the next run fetches its whole\n' +
      'window and pays GPT for all of it. The run after that is incremental.'
  );
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

interface YieldObservation {
  recorded: string;
  /** Identifies the cache state, so re-running prune cannot fake a second run. */
  fingerprint: string;
  sources: Record<string, { messages: number; events: number }>;
  /**
   * The config entries in effect when this was recorded. Required to judge a
   * source that produced NO cache entry at all: absence from `sources` is only
   * evidence of silence for an entry that was actually configured at the time,
   * and without this a source added today reads as having been silent through
   * every run that predates it. Absent on observations recorded before this
   * field existed, which are therefore skipped when judging silence.
   */
  configured?: string[];
}

function loadYieldHistory(): YieldObservation[] {
  if (!fs.existsSync(YIELD_HISTORY_FILE)) return [];
  const parsed = JSON.parse(fs.readFileSync(YIELD_HISTORY_FILE, 'utf-8')) as { observations?: YieldObservation[] };
  return parsed.observations ?? [];
}

function saveYieldHistory(observations: YieldObservation[]): void {
  fs.mkdirSync(path.dirname(YIELD_HISTORY_FILE), { recursive: true });
  fs.writeFileSync(YIELD_HISTORY_FILE, JSON.stringify({ observations }, null, 2));
}

/**
 * Prunes sources that have produced nothing across several runs.
 *
 * The evidence problem is the whole design. One cache snapshot cannot tell a
 * dead source from a quiet week, so every invocation records a snapshot and
 * judges only on the accumulated history — and it refuses to record a snapshot
 * identical to the last one, because otherwise running prune three times in a
 * row would manufacture three runs' worth of evidence from a single run.
 *
 * Sources are commented out, never deleted: the line is the only record that
 * the source was ever tried, and a deleted one gets rediscovered and re-added
 * on the next sweep.
 */
function prune(flags: Record<string, string>): void {
  const rows = computeYield();
  const observations = loadYieldHistory();
  const configured = loadConfiguredSources();

  const sources: Record<string, { messages: number; events: number }> = {};
  for (const row of rows) sources[row.source] = { messages: row.messages, events: row.events };
  const fingerprint = JSON.stringify(
    Object.entries(sources)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, c]) => `${name}:${c.messages}:${c.events}`)
  );

  const last = observations[observations.length - 1];
  if (last?.fingerprint === fingerprint) {
    console.log(
      `Caches are unchanged since the observation recorded at ${last.recorded} — not recording a\n` +
        'duplicate. Run the pipeline before pruning again, or this is one run counted twice.'
    );
  } else {
    observations.push({
      recorded: new Date().toISOString(),
      fingerprint,
      sources,
      configured: configured.all,
    });
    saveYieldHistory(observations);
    console.log(`Recorded observation ${observations.length} to ${path.basename(YIELD_HISTORY_FILE)}`);
  }

  // Identity of a configured entry: its own handle, or — for a display-name
  // entry — whatever the last `verify` run resolved it to.
  const identityMap = loadExpandedSection<Record<string, string | null>>('config_identity_map') ?? {};
  const identityOfEntry = (entry: string): string | undefined =>
    entry.startsWith('@') ? entry.slice(1).toLowerCase() : (identityMap[entry] ?? undefined)?.toLowerCase();

  const entryForSource = (source: string): string | undefined => {
    const wanted = source.toLowerCase();
    return configured.all.find((entry) => identityOfEntry(entry) === wanted);
  };

  const verdicts: { source: string; entry?: string; state: 'dead' | 'silent' | 'watching'; runs: number }[] = [];

  // Sources with cache entries: judged on what they produced.
  const allSources = new Set(observations.flatMap((o) => Object.keys(o.sources)));
  for (const source of allSources) {
    const seen = observations.filter((o) => o.sources[source] !== undefined).map((o) => o.sources[source]);
    const state =
      seen.length < MIN_DEAD_OBSERVATIONS ? 'watching' : seen.every((s) => s.events === 0) ? 'dead' : 'watching';
    verdicts.push({ source, entry: entryForSource(source), state, runs: seen.length });
  }

  /**
   * Configured entries with NO cache entry at all — the GeoDvij case, and the
   * only kind of dead source the counts above cannot see. An unresolvable source
   * returns early from fetchMessagesFromSource, before its cache key is ever
   * computed, so it leaves no trace in the message cache to be counted; silence
   * has to be inferred from the config side instead.
   *
   * Judged only against observations that recorded a config list AND listed this
   * entry, so an entry added after those runs is not blamed for them.
   */
  const unresolvable: string[] = [];
  for (const entry of configured.all) {
    const identity = identityOfEntry(entry);
    if (identity && allSources.has(identity)) continue;

    // No resolved identity means we cannot tell "produced nothing" from "we have
    // no idea what this entry is". A display-name entry has no identity until
    // `verify` has run, and condemning it on that basis would prune every
    // private group in the config the first time prune runs without one.
    // Unknown is not dead.
    if (!identity) {
      unresolvable.push(entry);
      verdicts.push({ source: `(unresolved) ${entry}`, entry, state: 'watching', runs: 0 });
      continue;
    }

    const relevant = observations.filter((o) => o.configured?.includes(entry));
    if (relevant.length < MIN_DEAD_OBSERVATIONS) {
      verdicts.push({ source: identity, entry, state: 'watching', runs: relevant.length });
      continue;
    }
    verdicts.push({ source: identity, entry, state: 'silent', runs: relevant.length });
  }

  const dead = verdicts.filter((v) => v.state === 'dead');
  const silent = verdicts.filter((v) => v.state === 'silent');
  const condemned = [...dead, ...silent];

  console.log(
    `\n${observations.length} observation(s) on record; a source needs ${MIN_DEAD_OBSERVATIONS} ` + 'to be judged.'
  );
  console.log(`  ${dead.length} dead (fetched messages, produced no events)`);
  console.log(`  ${silent.length} silent (never fetched a single message)`);
  console.log(`  ${verdicts.length - condemned.length} still healthy or under observation`);

  for (const v of condemned) {
    console.log(`  ${v.state.padEnd(7)} ${String(v.runs).padStart(2)} runs  ${v.source}  ${v.entry ?? '(unmapped)'}`);
  }

  const unmapped = condemned.filter((v) => !v.entry);
  if (unmapped.length > 0) {
    console.log(
      `\n${unmapped.length} condemned source(s) could not be tied back to a config entry. Display-name\n` +
        'entries resolve only through expand-sources.ts verify — run it to refresh the identity map.'
    );
  }
  if (unresolvable.length > 0) {
    console.log(
      `\n${unresolvable.length} config entr(ies) have no resolved identity and were NOT judged:\n` +
        `  ${unresolvable.join(', ')}\n` +
        '  These are display-name entries with no entry in the identity map, so there is no way to\n' +
        '  tell a dead source from an unidentified one. Run expand-sources.ts verify to resolve them.'
    );
  }

  const actionable = condemned.filter((v) => v.entry);
  if (actionable.length === 0) {
    console.log('\nNothing to prune — config.yaml unchanged.');
    return;
  }

  // Blast-radius guard. See MAX_PRUNE_SHARE: a huge prune means lost evidence
  // far more often than it means a lot of dead sources.
  const ceiling = Math.max(1, Math.floor(configured.all.length * MAX_PRUNE_SHARE));
  if (actionable.length > ceiling && !isFlagSet(flags, 'force')) {
    console.log(
      `\nREFUSING to prune: ${actionable.length} of ${configured.all.length} configured sources are\n` +
        `condemned, over the ceiling of ${ceiling} (${Math.round(MAX_PRUNE_SHARE * 100)}%). Silence is\n` +
        'inferred from a MISSING cache entry, so this pattern usually means the evidence is gone,\n' +
        'not that the sources are. Check in this order:\n' +
        `  1. Is .cache/telegram_messages.json intact? Deleting it makes every source look silent.\n` +
        '  2. Has the pipeline actually run since these observations were recorded?\n' +
        '  3. Is the identity map current? Re-run expand-sources.ts verify.\n' +
        'config.yaml unchanged. Pass --force to prune anyway.'
    );
    return;
  }

  if (isFlagSet(flags, 'dry-run')) {
    console.log(`\n--dry-run — would comment out ${actionable.length} entr(ies).`);
    return;
  }

  const lines = fs.readFileSync(CONFIG_FILE, 'utf-8').split('\n');
  const backup = backupConfig();
  const applied: string[] = [];
  for (const v of actionable) {
    const reason =
      v.state === 'silent'
        ? `fetched nothing across ${v.runs} runs (unresolvable or empty)`
        : `zero events across ${v.runs} runs`;
    if (commentOutEntry(lines, v.entry as string, reason)) applied.push(v.entry as string);
  }

  if (applied.length === 0) {
    fs.unlinkSync(backup);
    console.log('\nNo matching config lines found — config.yaml unchanged.');
    return;
  }
  fs.writeFileSync(CONFIG_FILE, lines.join('\n'));
  console.log(`\nBacked up to ${path.basename(backup)}`);
  console.log(`Commented out ${applied.length}: ${applied.join(', ')}`);
}

async function main(): Promise<void> {
  const [command = 'discover', ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case 'discover':
      discover(flags);
      break;
    case 'validate':
      validate(flags);
      break;
    case 'yield':
      yieldAudit();
      break;
    case 'add':
      add(flags);
      break;
    case 'prune':
      prune(flags);
      break;
    default:
      console.log(
        'usage:\n' +
          '  npx ts-node scripts/discover-sources.ts discover [--db=] [--since=YYYY-MM-DD] [--limit=N]\n' +
          '  npx ts-node scripts/discover-sources.ts validate [--db=] [--since=YYYY-MM-DD]\n' +
          '  npx ts-node scripts/discover-sources.ts yield\n' +
          '  npx ts-node scripts/discover-sources.ts add   [--dry-run] [--force]\n' +
          '  npx ts-node scripts/discover-sources.ts prune [--dry-run]'
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
