/**
 * Expands a reviewed candidate list using Telegram's own discovery endpoints.
 *
 *   npx ts-node scripts/expand-sources.ts similar [--seeds=a,b,c] [--max-calls=N]
 *   npx ts-node scripts/expand-sources.ts folders [--max-calls=N]
 *   npx ts-node scripts/expand-sources.ts resolve  [--max-calls=N]
 *   npx ts-node scripts/expand-sources.ts verify  [--candidates=a,b] [--max-calls=N]
 *
 * `similar` — channels.getChannelRecommendations over your configured channels
 *             plus any seeds you pass. Telegram's own subscriber-overlap graph,
 *             so it surfaces channels that share an audience without sharing
 *             vocabulary. Large channels return roughly a dozen; small ones
 *             return none, and the list is truncated without Premium.
 * `folders` — chatlists.checkChatlistInvite over the t.me/addlist/ hashes found
 *             by discover-sources.ts. Returns a shared folder's full contents
 *             WITHOUT joining anything. Highest precision here: a human curated
 *             each bundle.
 * `resolve` — turns forward-graph channel IDs from discover-sources.ts into
 *             @handles. Mostly a session-cache lookup: those channels reached
 *             you through forwarded messages, so their access hashes are often
 *             already stored locally.
 * `verify`  — the gate in front of discover-sources.ts `add`. Resolves every
 *             candidate handle the other commands produced and decides three
 *             things no offline pass can know: whether it exists, whether it is
 *             a broadcast channel or a group, and whether it is already
 *             monitored under some other label. Only what survives all three is
 *             written to the `verified` section for `add` to consume.
 *
 * Why verify has to be online. Two things are invisible offline:
 *   - Wrong bucket. What this costs depends on the entry form, and it is worth
 *     being exact: fetchMessagesFromSource only type-checks the DISPLAY-NAME
 *     branch (`dialog.isGroup` / `dialog.isChannel`), so a display-name entry in
 *     the wrong list matches no dialog and fetches nothing on every run forever
 *     — that is the `REDACTED-CHAT-NAME` line in config.yaml. An `@handle` entry
 *     resolves by username with no type check at all, so a wrong bucket there is
 *     not fatal: it applies the wrong message limit (maxGroupMessages 200 vs
 *     maxChannelMessages 50) and files the source under the wrong cache-key
 *     prefix, which skews yield accounting. `add` only ever writes handles, so
 *     the milder case is the one it can cause — but the limit is a 4x
 *     difference in what gets read, so the bucket still has to be right.
 *   - Hidden duplicate: config entries are handles OR display names, and only
 *     the RESOLVED name is comparable. "Musicians in Tbilisi" and
 *     "@musicians_in_tbilisi" are one chat wearing two labels; string-matching
 *     config.yaml sees two. One getDialogs call resolves every display-name
 *     entry to the same `username`-or-`c/<id>` identity the pipeline caches
 *     under, which is what makes the comparison exact.
 *
 * RUN THIS ALONE. It opens .telegram-session, which the pipeline also uses, and
 * two clients on one session invite trouble. Never run it during a digest run.
 *
 * Rate limiting is the whole design constraint. contacts.ResolveUsername floods
 * are what made data/entity-cache.ts necessary in the first place, so every call
 * is spaced, capped per run, and the script aborts outright on the first
 * FLOOD_WAIT rather than retrying into a longer ban.
 */

import fs from 'fs';
import path from 'path';

import bigInt from 'big-integer';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import { Api, TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

dotenv.config();

const CONFIG_FILE = path.resolve(process.cwd(), 'config.yaml');
const SESSION_FILE = path.resolve(process.cwd(), '.telegram-session');
const DISCOVERED_FILE = path.resolve(process.cwd(), 'debug/discovered-sources.yaml');
const OUTPUT_FILE = path.resolve(process.cwd(), 'debug/expanded-sources.yaml');
const CACHE_DIR = path.resolve(process.cwd(), '.cache');

/**
 * Dialogs read in one call to resolve every display-name config entry.
 *
 * Must stay equal to DIALOG_FETCH_LIMIT in src/data/telegram-client.ts. This is
 * not a performance knob: a display-name entry past the limit does not resolve
 * at RUNTIME either, so matching the pipeline's cap is what makes "already
 * monitored" here mean the same thing it means during a digest. Raise one and
 * the two disagree — verify would claim a source is covered that the pipeline
 * never finds.
 */
const DIALOG_LIMIT = 500;

/** Spacing between MTProto calls. Deliberately slower than the pipeline's 1s. */
const CALL_DELAY_MS = 2500;

/** Hard ceiling per run. Discovery is never urgent enough to risk a ban. */
const DEFAULT_MAX_CALLS = 40;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accepts `--key=value` and a bare `--key`; see the note in discover-sources.ts. */
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

/** A FLOOD_WAIT means back off entirely; retrying is how a short ban becomes long. */
function isFloodWait(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FLOOD|flood/.test(message);
}

interface DiscoveredReport {
  external_references?: { name: string; channel_id?: string }[];
  bundles_for_live_expansion?: { addlist?: string[]; invite?: string[] };
}

function loadDiscovered(): DiscoveredReport {
  if (!fs.existsSync(DISCOVERED_FILE)) {
    throw new Error(`${DISCOVERED_FILE} not found. Run discover-sources.ts discover first.`);
  }
  return yaml.load(fs.readFileSync(DISCOVERED_FILE, 'utf-8')) as DiscoveredReport;
}

function loadConfiguredChannels(): string[] {
  const raw = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf-8')) as { channelsToParse?: string[] };
  return (raw.channelsToParse ?? []).filter((c) => c.startsWith('@')).map((c) => c.slice(1));
}

/** Every configured entry, in both lists, handles and display names alike. */
function loadConfiguredSources(): { channels: string[]; groups: string[]; all: string[] } {
  const raw = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf-8')) as {
    channelsToParse?: string[];
    groupsToParse?: string[];
  };
  const channels = raw.channelsToParse ?? [];
  const groups = raw.groupsToParse ?? [];
  return { channels, groups, all: [...channels, ...groups] };
}

function writeReport(section: string, payload: unknown): void {
  const existing = fs.existsSync(OUTPUT_FILE)
    ? (yaml.load(fs.readFileSync(OUTPUT_FILE, 'utf-8')) as Record<string, unknown>)
    : {};
  existing[section] = payload;
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, yaml.dump(existing, { lineWidth: 120 }));
  console.log(`\nWrote ${section} to ${OUTPUT_FILE}`);
}

/**
 * Opens a client on the pipeline's existing session. Read-only discovery, so it
 * refuses to start an interactive login: if the session is missing or stale, the
 * fix is to run the pipeline once, not to authenticate from here.
 */
async function connect(): Promise<GramJSClient> {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not set — see .env.example');
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`${SESSION_FILE} not found. Run the pipeline once to authenticate first.`);
  }

  const session = new StringSession(fs.readFileSync(SESSION_FILE, 'utf-8').trim());
  const client = new GramJSClient(session, apiId, apiHash, { connectionRetries: 3 });
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    throw new Error('Saved session is not authorised. Run the pipeline to refresh it.');
  }
  return client;
}

/** Guards every MTProto call: spacing, a per-run budget, and flood abort. */
class CallBudget {
  private used = 0;

  constructor(private readonly max: number) {}

  get spent(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.max;
  }

  async run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.exhausted) return null;
    if (this.used > 0) await delay(CALL_DELAY_MS);
    this.used += 1;
    try {
      return await fn();
    } catch (error) {
      if (isFloodWait(error)) {
        throw new Error(
          `FLOOD_WAIT on ${label} after ${this.used} calls. Aborting — wait it out, ` + 'do not rerun immediately.'
        );
      }
      console.log(`  ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

/** Both Chats and ChatsSlice carry `chats`; only the slice knows the real total. */
function unpackChats(result: unknown): { chats: Api.TypeChat[]; total?: number } {
  const chats = (result as Api.messages.Chats).chats ?? [];
  const total = (result as Api.messages.ChatsSlice).count;
  return { chats, total: typeof total === 'number' ? total : undefined };
}

/**
 * getInputEntity yields an InputPeer, but GetChannelRecommendations takes an
 * InputChannel. Returns null for anything that is not a channel — users and
 * basic groups have no recommendations to ask for.
 */
function toInputChannel(peer: Api.TypeInputPeer): Api.InputChannel | null {
  if (peer instanceof Api.InputPeerChannel) {
    return new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
  }
  return null;
}

function describeChat(chat: Api.TypeChat): { title: string; username?: string } {
  const channel = chat as Api.Channel;
  return { title: channel.title ?? '(untitled)', username: channel.username ?? undefined };
}

async function similar(flags: Record<string, string>): Promise<void> {
  const budget = new CallBudget(flags['max-calls'] ? parseInt(flags['max-calls'], 10) : DEFAULT_MAX_CALLS);
  const configured = loadConfiguredChannels();
  const seeds = flags.seeds ? flags.seeds.split(',').map((s) => s.trim().replace(/^@/, '')) : configured;
  const known = new Set(configured.map((c) => c.toLowerCase()));

  const client = await connect();
  const found = new Map<string, { title: string; username?: string; seeds: string[] }>();
  let visited = 0;

  try {
    for (const seed of seeds) {
      if (budget.exhausted) break;
      visited += 1;

      // getInputEntity is session-cache-first, so a channel the pipeline already
      // fetches costs nothing; it is inside the budget in case it is not.
      const input = await budget.run(`input:${seed}`, () => client.getInputEntity(seed));
      if (!input) continue;

      const channel = toInputChannel(input);
      if (!channel) {
        console.log(`  @${seed}: not a channel — skipped`);
        continue;
      }

      const result = await budget.run(`similar:${seed}`, () =>
        client.invoke(new Api.channels.GetChannelRecommendations({ channel }))
      );
      if (!result) continue;

      const { chats, total } = unpackChats(result);
      console.log(
        `  @${seed}: ${chats.length} similar` +
          (total && total > chats.length ? ` (of ${total} — truncated, non-Premium)` : '')
      );

      for (const chat of chats) {
        const { title, username } = describeChat(chat);
        const key = (username ?? title).toLowerCase();
        if (known.has(key)) continue;
        const entry = found.get(key) ?? { title, username, seeds: [] };
        entry.seeds.push(seed);
        found.set(key, entry);
      }
    }
  } finally {
    await client.disconnect();
  }

  if (visited < seeds.length) {
    console.log(`\nBudget stopped the sweep at ${visited}/${seeds.length} seeds — rerun to continue.`);
  }

  // Recommended by several of your channels at once is the strongest signal here.
  const ranked = [...found.values()].sort((a, b) => b.seeds.length - a.seeds.length);
  console.log(`\n${ranked.length} candidates from ${budget.spent} calls`);
  console.log('  seeds  name');
  for (const c of ranked.slice(0, 40)) {
    console.log(`  ${String(c.seeds.length).padStart(5)}  ${c.username ? '@' + c.username : c.title}`);
  }

  writeReport(
    'similar_channels',
    ranked.map((c) => ({
      name: c.username ? `@${c.username}` : c.title,
      title: c.title,
      recommended_by: c.seeds,
    }))
  );
}

async function folders(flags: Record<string, string>): Promise<void> {
  const budget = new CallBudget(flags['max-calls'] ? parseInt(flags['max-calls'], 10) : DEFAULT_MAX_CALLS);
  const hashes = loadDiscovered().bundles_for_live_expansion?.addlist ?? [];
  if (hashes.length === 0) throw new Error('No addlist hashes in the discover report.');

  const known = new Set(loadConfiguredChannels().map((c) => c.toLowerCase()));
  const client = await connect();
  const bundles: { hash: string; title: string; members: string[] }[] = [];

  try {
    for (const hash of hashes) {
      if (budget.exhausted) break;
      const result = await budget.run(`folder:${hash}`, () =>
        client.invoke(new Api.chatlists.CheckChatlistInvite({ slug: hash }))
      );
      if (!result) continue;

      // ChatlistInviteAlready comes back for folders already imported; it has no
      // title but still lists the peers, which is the part worth reading.
      const invite = result as Api.chatlists.ChatlistInvite & { title?: string };
      const members = (invite.chats ?? [])
        .map(describeChat)
        .filter((c) => !known.has((c.username ?? c.title).toLowerCase()))
        .map((c) => (c.username ? `@${c.username}` : c.title));

      const title = typeof invite.title === 'string' ? invite.title : '(already imported)';
      bundles.push({ hash, title, members });
      console.log(`  ${hash}: "${title}" — ${members.length} new of ${invite.chats?.length ?? 0}`);
    }
  } finally {
    await client.disconnect();
  }

  if (budget.exhausted && hashes.length > bundles.length) {
    console.log(`\n${hashes.length - bundles.length} folders left unopened by the call budget.`);
  }
  console.log(`\n${bundles.length} folders opened in ${budget.spent} calls`);
  writeReport('shared_folders', bundles);
}

async function resolve(flags: Record<string, string>): Promise<void> {
  const budget = new CallBudget(flags['max-calls'] ? parseInt(flags['max-calls'], 10) : DEFAULT_MAX_CALLS);

  // Only forward-graph candidates lack a handle; link candidates already have one.
  const pending = (loadDiscovered().external_references ?? []).filter((c) => c.channel_id && !c.name.startsWith('@'));
  if (pending.length === 0) throw new Error('No unresolved channel IDs in the discover report.');

  const client = await connect();
  const resolved: { channel_id: string; display_name: string; handle?: string; note?: string }[] = [];

  try {
    for (const candidate of pending) {
      if (budget.exhausted) break;
      const channelId = candidate.channel_id as string;

      // A bare channel ID is unusable without its access hash. These channels
      // reached the account via forwards, so the hash is usually in the session
      // already and this resolves with no network call at all.
      const entity = await budget.run(`resolve:${channelId}`, async () => {
        const peer = new Api.PeerChannel({ channelId: bigInt(channelId) });
        return client.getEntity(await client.getInputEntity(peer));
      });

      if (!entity) {
        resolved.push({
          channel_id: channelId,
          display_name: candidate.name,
          note: 'no access hash in session — reachable only by joining or a public link',
        });
        continue;
      }

      const username = (entity as Api.Channel).username ?? undefined;
      resolved.push({ channel_id: channelId, display_name: candidate.name, handle: username });
      console.log(`  ${candidate.name} → ${username ? '@' + username : 'private, no public handle'}`);
    }
  } finally {
    await client.disconnect();
  }

  const withHandles = resolved.filter((r) => r.handle).length;
  console.log(`\nResolved ${withHandles}/${pending.length} to public handles in ${budget.spent} calls`);
  if (pending.length > resolved.length) {
    console.log(`${pending.length - resolved.length} left unattempted by the call budget — rerun later.`);
  }
  writeReport('resolved_handles', resolved);
}

// ---------------------------------------------------------------------------
// verify — the gate in front of `discover-sources.ts add`
// ---------------------------------------------------------------------------

type Bucket = 'channelsToParse' | 'groupsToParse';

/**
 * Which config list an entity belongs in. The pipeline matches a display-name
 * entry against `dialog.isGroup` or `dialog.isChannel`, so this is the one
 * decision that silently costs every future run if it is wrong.
 */
function classifyEntity(entity: unknown): { bucket: Bucket | null; kind: string } {
  if (entity instanceof Api.Channel) {
    if (entity.broadcast) return { bucket: 'channelsToParse', kind: 'broadcast channel' };
    if (entity.megagroup) return { bucket: 'groupsToParse', kind: 'supergroup' };
    // Gigagroups and forum channels set neither flag. They behave as groups for
    // history reads, so they go to groupsToParse and say so in the report.
    return { bucket: 'groupsToParse', kind: 'channel, neither broadcast nor megagroup' };
  }
  if (entity instanceof Api.Chat) return { bucket: 'groupsToParse', kind: 'basic group' };
  if (entity instanceof Api.User) {
    return { bucket: null, kind: 'user — a personal chat, which no group-type check can ever match' };
  }
  const className = (entity as { className?: string })?.className;
  return { bucket: null, kind: `unusable (${className ?? typeof entity})` };
}

/**
 * The name the pipeline would cache this entity under: a username when it has
 * one, `c/<id>` when it does not. Mirrors TelegramClient.findEntityByDisplayName
 * so "already monitored" means here exactly what it means at runtime.
 */
function cacheIdentity(entity: unknown): string | null {
  if (entity instanceof Api.Channel) {
    return entity.username ? entity.username.toLowerCase() : `c/${entity.id}`;
  }
  if (entity instanceof Api.Chat) return `c/${entity.id}`;
  return null;
}

/** Source names already monitored, read off the keys the pipeline itself wrote. */
function identitiesFromMessageCache(): Set<string> {
  const file = path.join(CACHE_DIR, 'telegram_messages.json');
  if (!fs.existsSync(file)) return new Set();
  const cache = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  // Keys are `<type>:<source>:<limit>`, and a private group's source is `c/<id>`,
  // which itself contains a colon-free slash — so slice off the ends, not split[1].
  return new Set(Object.keys(cache).map((key) => key.split(':').slice(1, -1).join(':').toLowerCase()));
}

interface CandidateOrigin {
  handle: string;
  origins: string[];
}

/** Every @handle the discover and expand passes produced, with its provenance. */
function collectCandidates(flags: Record<string, string>): CandidateOrigin[] {
  const found = new Map<string, Set<string>>();
  const add = (raw: string, origin: string): void => {
    const handle = raw.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z][a-z0-9_]{3,31}$/.test(handle)) return;
    const entry = found.get(handle) ?? new Set<string>();
    entry.add(origin);
    found.set(handle, entry);
  };

  if (flags.candidates) {
    for (const raw of flags.candidates.split(',')) add(raw, 'cli');
  } else {
    // Both reports are optional: verify is useful with either one alone.
    if (fs.existsSync(DISCOVERED_FILE)) {
      const discovered = loadDiscovered() as DiscoveredReport & {
        paste_ready?: { channelsToParse?: string[] };
      };
      for (const name of discovered.paste_ready?.channelsToParse ?? []) add(name, 'archive-links');
      for (const ref of discovered.external_references ?? []) {
        if (ref.name?.startsWith('@')) add(ref.name, 'archive-refs');
      }
    }
    if (fs.existsSync(OUTPUT_FILE)) {
      const expanded = (yaml.load(fs.readFileSync(OUTPUT_FILE, 'utf-8')) ?? {}) as {
        similar_channels?: { name?: string }[];
        shared_folders?: { members?: string[] }[];
        resolved_handles?: { handle?: string }[];
      };
      for (const c of expanded.similar_channels ?? []) if (c.name?.startsWith('@')) add(c.name, 'similar');
      for (const bundle of expanded.shared_folders ?? []) {
        for (const member of bundle.members ?? []) if (member.startsWith('@')) add(member, 'folder');
      }
      for (const r of expanded.resolved_handles ?? []) if (r.handle) add(r.handle, 'forward-graph');
    }
  }

  return [...found.entries()]
    .map(([handle, origins]) => ({ handle, origins: [...origins].sort() }))
    .sort((a, b) => b.origins.length - a.origins.length || a.handle.localeCompare(b.handle));
}

interface VerifiedEntry {
  handle: string;
  bucket: Bucket;
  title: string;
  kind: string;
  participants?: number;
  origins: string[];
  /** Has cache history but is not in config — i.e. previously pruned. */
  readded?: true;
}
interface RejectedEntry {
  handle: string;
  reason: string;
}

async function verify(flags: Record<string, string>): Promise<void> {
  const budget = new CallBudget(flags['max-calls'] ? parseInt(flags['max-calls'], 10) : DEFAULT_MAX_CALLS);
  const candidates = collectCandidates(flags);
  if (candidates.length === 0) {
    throw new Error('No candidate handles. Run discover/similar/folders first, or pass --candidates=a,b.');
  }

  const configured = loadConfiguredSources();
  const configuredHandles = new Set(
    configured.all.filter((s) => s.startsWith('@')).map((s) => s.slice(1).toLowerCase())
  );

  // Display-name entries, each kept with the list it came from: the pipeline
  // filters dialogs by type before matching titles, so resolving one without
  // that filter can land on a dialog the pipeline would have skipped.
  const displayNameEntries = [
    ...configured.channels.filter((s) => !s.startsWith('@')).map((name) => ({ name, type: 'channel' as const })),
    ...configured.groups.filter((s) => !s.startsWith('@')).map((name) => ({ name, type: 'group' as const })),
  ];

  // Identity → the config entry that owns it, so a rejection can name its cause.
  // Populated from config ONLY. The message cache deliberately does not feed
  // this: cache keys are never pruned, so a source removed from config still has
  // one, and treating that as "monitored" would make a pruned source impossible
  // to ever re-add — the rediscovery path that commenting-out rather than
  // deleting exists to preserve.
  const monitored = new Map<string, string>();
  for (const handle of configuredHandles) monitored.set(handle, `@${handle}`);

  // Kept separate, as an annotation rather than a veto.
  const previouslyFetched = identitiesFromMessageCache();

  console.log(`Verifying ${candidates.length} candidates against ${configured.all.length} configured sources\n`);

  const client = await connect();
  const addable: VerifiedEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const identityMap: Record<string, string | null> = {};
  /** Candidates the loop got to. The rest were cut off by the call budget. */
  let reached = 0;

  try {
    // One call resolves every display-name entry. Without this the duplicate
    // check can only see handles, and a display-name entry for the same chat
    // reads as a different source — the bug that put one chat in twice.
    if (displayNameEntries.length > 0) {
      const dialogs = await budget.run('dialogs', () => client.getDialogs({ limit: DIALOG_LIMIT }));
      if (!dialogs) {
        console.log('  ⚠ could not read dialogs — display-name entries cannot be checked for duplicates');
      } else {
        for (const { name, type } of displayNameEntries) {
          const lower = name.toLowerCase();
          // Same rule as findEntityByDisplayName, in the same order: filter by
          // type FIRST, then take the first title containing the entry. Without
          // the type filter a group entry can match a channel that the pipeline
          // would have skipped, yielding an identity the pipeline never uses.
          const hit = dialogs.find(
            (d) => (type === 'channel' ? d.isChannel : d.isGroup) && (d.title ?? '').toLowerCase().includes(lower)
          );
          const identity = hit ? cacheIdentity(hit.entity) : null;
          identityMap[name] = identity;
          if (identity) monitored.set(identity, `"${name}"`);
        }
        const unresolved = Object.entries(identityMap)
          .filter(([, v]) => !v)
          .map(([k]) => k);
        console.log(
          `  dialogs: resolved ${displayNameEntries.length - unresolved.length}/${displayNameEntries.length} ` +
            `display-name entries` +
            (unresolved.length ? ` (no dialog for: ${unresolved.join(', ')})` : '')
        );
      }
    }

    for (const candidate of candidates) {
      // Free rejection — costs no call, so the budget goes to real unknowns, and
      // it stays outside the exhaustion check so a spent budget still reports it.
      if (configuredHandles.has(candidate.handle)) {
        rejected.push({ handle: `@${candidate.handle}`, reason: 'already in config.yaml by handle' });
        reached += 1;
        continue;
      }
      if (budget.exhausted) break;
      reached += 1;
      const entity = await budget.run(`verify:${candidate.handle}`, () => client.getEntity(candidate.handle));
      if (!entity) {
        rejected.push({
          handle: `@${candidate.handle}`,
          reason: 'did not resolve — dead handle, private, or the call failed',
        });
        continue;
      }

      const identity = cacheIdentity(entity);
      const owner = identity ? monitored.get(identity) : undefined;
      if (owner) {
        rejected.push({
          handle: `@${candidate.handle}`,
          reason: `already monitored as ${owner} — same chat, different label`,
        });
        console.log(`  @${candidate.handle}: duplicate of ${owner}`);
        continue;
      }

      const { bucket, kind } = classifyEntity(entity);
      if (!bucket) {
        rejected.push({ handle: `@${candidate.handle}`, reason: `not addable: ${kind}` });
        console.log(`  @${candidate.handle}: ${kind}`);
        continue;
      }

      const named = entity as Api.Channel;
      const entry: VerifiedEntry = {
        handle: `@${candidate.handle}`,
        bucket,
        title: named.title ?? candidate.handle,
        kind,
        participants: typeof named.participantsCount === 'number' ? named.participantsCount : undefined,
        origins: candidate.origins,
        // Fetched under some past config, but not configured now — almost always
        // a source that was pruned. Recorded so the operator can see it is being
        // re-added rather than added, but it does not block the add: the message
        // cache is never pruned, so this state is permanent once it happens.
        readded: identity && previouslyFetched.has(identity) ? true : undefined,
      };
      addable.push(entry);
      // Claim the identity so two candidate handles for one chat cannot both pass.
      if (identity) monitored.set(identity, `@${candidate.handle} (this run)`);
      console.log(`  @${candidate.handle}: ${kind} → ${bucket}  "${entry.title}"`);
    }
  } finally {
    await client.disconnect();
  }

  const unattempted = candidates.slice(reached).map((c) => `@${c.handle}`);

  console.log(`\n${addable.length} addable, ${rejected.length} rejected, ${budget.spent} calls spent`);
  for (const bucket of ['channelsToParse', 'groupsToParse'] as Bucket[]) {
    const inBucket = addable.filter((a) => a.bucket === bucket);
    if (inBucket.length > 0) console.log(`  ${bucket}: ${inBucket.map((a) => a.handle).join(', ')}`);
  }
  const readded = addable.filter((a) => a.readded);
  if (readded.length > 0) {
    console.log(
      `  re-added (has cache history, not currently configured — likely pruned before): ` +
        readded.map((a) => a.handle).join(', ')
    );
  }
  if (unattempted.length > 0) {
    console.log(`\n${unattempted.length} left unattempted by the call budget — rerun to continue.`);
  }

  writeReport('verified', {
    // `add` refuses a stale section: a verdict about what is already monitored
    // goes out of date as soon as config.yaml changes.
    generated: new Date().toISOString(),
    addable,
    rejected,
    unattempted,
  });
  // Written separately so the offline `prune` can map a cache source name back
  // to the config entry that produced it.
  if (Object.keys(identityMap).length > 0) writeReport('config_identity_map', identityMap);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case 'similar':
      await similar(flags);
      break;
    case 'folders':
      await folders(flags);
      break;
    case 'resolve':
      await resolve(flags);
      break;
    case 'verify':
      await verify(flags);
      break;
    default:
      console.log(
        'usage (run alone — shares .telegram-session with the pipeline):\n' +
          '  npx ts-node scripts/expand-sources.ts similar [--seeds=a,b] [--max-calls=N]\n' +
          '  npx ts-node scripts/expand-sources.ts folders [--max-calls=N]\n' +
          '  npx ts-node scripts/expand-sources.ts resolve [--max-calls=N]\n' +
          '  npx ts-node scripts/expand-sources.ts verify [--candidates=a,b] [--max-calls=N]'
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
