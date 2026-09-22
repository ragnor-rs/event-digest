/**
 * Expands a reviewed candidate list using Telegram's own discovery endpoints.
 *
 *   npx ts-node scripts/expand-sources.ts similar [--seeds=a,b,c] [--max-calls=N]
 *   npx ts-node scripts/expand-sources.ts folders [--max-calls=N]
 *   npx ts-node scripts/expand-sources.ts resolve  [--max-calls=N]
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

/** Spacing between MTProto calls. Deliberately slower than the pipeline's 1s. */
const CALL_DELAY_MS = 2500;

/** Hard ceiling per run. Discovery is never urgent enough to risk a ban. */
const DEFAULT_MAX_CALLS = 40;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
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
    default:
      console.log(
        'usage (run alone — shares .telegram-session with the pipeline):\n' +
          '  npx ts-node scripts/expand-sources.ts similar [--seeds=a,b] [--max-calls=N]\n' +
          '  npx ts-node scripts/expand-sources.ts folders [--max-calls=N]\n' +
          '  npx ts-node scripts/expand-sources.ts resolve [--max-calls=N]'
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
