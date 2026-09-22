/**
 * Finds candidate Telegram sources by mining a local Telegram export archive.
 *
 *   npx ts-node scripts/discover-sources.ts discover [--db=path] [--since=YYYY-MM-DD] [--limit=N]
 *   npx ts-node scripts/discover-sources.ts validate [--db=path] [--since=YYYY-MM-DD]
 *   npx ts-node scripts/discover-sources.ts yield
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

import yaml from 'js-yaml';

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

const DEFAULT_DB = path.resolve(process.cwd(), '../personal/_meta/sources/telegram.db');
const OUTPUT_FILE = path.resolve(process.cwd(), 'debug/discovered-sources.yaml');
const CONFIG_FILE = path.resolve(process.cwd(), 'config.yaml');
const CACHE_DIR = path.resolve(process.cwd(), '.cache');

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

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
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

function openArchive(flags: Record<string, string>): SqliteDb {
  const dbPath = flags.db ?? process.env.TELEGRAM_ARCHIVE_DB ?? DEFAULT_DB;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Archive not found at ${dbPath}. Pass --db=<path> or set TELEGRAM_ARCHIVE_DB.`);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
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

/**
 * Per-source yield from the pipeline caches. A source that never produces a
 * surviving event still costs GPT tokens and Telegram calls on every run.
 */
function yieldAudit(): void {
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

  const rows = [...counts.entries()]
    .map(([source, c]) => ({
      source,
      ...c,
      per100: c.messages > 0 ? (c.events / c.messages) * 100 : 0,
    }))
    .sort((a, b) => b.per100 - a.per100 || b.events - a.events);

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
    default:
      console.log(
        'usage:\n' +
          '  npx ts-node scripts/discover-sources.ts discover [--db=] [--since=YYYY-MM-DD] [--limit=N]\n' +
          '  npx ts-node scripts/discover-sources.ts validate [--db=] [--since=YYYY-MM-DD]\n' +
          '  npx ts-node scripts/discover-sources.ts yield'
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
