/**
 * Step 0 of source discovery: produce the local Telegram archive that
 * `discover-sources.ts discover` mines.
 *
 * Why this exists. `discover` reads a SQLite export of your own dialogs, but
 * until now the project had no way to make one — the archive was assumed to
 * already exist at a path baked into the script. That made step 1 unreachable
 * for anyone but its author. This closes the suite: export, then discover.
 *
 * What it writes. Only the columns `discover` actually reads:
 *
 *   chats    (id, telegram_id, name, type)
 *   messages (chat_id, message_id, date, text,
 *             is_forwarded, forwarded_from, forwarded_from_id)
 *
 * `type` uses Telegram Desktop's JSON-export vocabulary — `personal_chat`,
 * `private_group`, `private_supergroup`, `channel`, `saved_messages` — because
 * that is what `discover` already keys its NOT_ADDABLE_TYPES set on, and an
 * archive made by Telegram's own exporter has to stay readable by the same
 * query. `forwarded_from_id` keeps the export's `channel<id>` / `user<id>`
 * shape for the same reason: the forward-graph query filters on
 * `LIKE 'channel%'`.
 *
 * Incremental by design. The archive records the highest message_id seen per
 * chat and a rerun fetches only past it, mirroring how the digest's message
 * cache uses minId. This is not just a speed trick — a full sweep is thousands
 * of MTProto calls, so it *will* meet the call budget or a FLOOD_WAIT partway.
 * Resumability is what makes an interrupted export useful rather than wasted:
 * stop any time, rerun tomorrow, and it continues where it stopped.
 *
 * Flood policy is the one the discovery skill states: every call spaced
 * CALL_DELAY_MS, capped by --max-calls, and the first FLOOD_WAIT aborts the
 * whole command rather than retrying into a longer ban.
 *
 * Nothing leaves the machine. This writes a local file and makes no request
 * anywhere but Telegram, which already has these messages.
 *
 * Usage:
 *   npx ts-node scripts/export-telegram.ts [--out=<path>] [--months=12]
 *                                          [--max-calls=600] [--dialog-limit=N]
 *                                          [--include-personal] [--dry-run]
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Api, TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

const SESSION_FILE = path.resolve(process.cwd(), '.telegram-session');

/** Matches the discovery scripts: 2.5s between calls. */
const CALL_DELAY_MS = 2500;

/**
 * Higher than discovery's 40 because an export is inherently many calls — one
 * getDialogs plus at least one getHistory page per chat. Still a cap rather
 * than "until done", and the archive is resumable, so the honest default is
 * "a long but bounded session" rather than an unbounded sweep.
 */
const DEFAULT_MAX_CALLS = 600;

/** How far back to export. Matches the window discovery scores over. */
const DEFAULT_MONTHS = 12;

/** Messages per getHistory page. Telegram's own maximum for this call. */
const PAGE_SIZE = 100;

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
type SqliteCtor = new (filename: string, options?: { readOnly?: boolean }) => SqliteDb;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: SqliteCtor };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A FLOOD_WAIT means back off entirely; retrying is how a short ban becomes long. */
function isFloodWait(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FLOOD|flood/.test(message);
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
          `FLOOD_WAIT on ${label} after ${this.used} calls. Aborting — wait it out, ` +
            'do not rerun immediately. The archive keeps what it already wrote; ' +
            'rerun on a later day to continue.'
        );
      }
      console.log(`  ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

/**
 * Opens a client on the pipeline's existing session. Read-only, so it refuses
 * an interactive login: if the session is missing or stale, the fix is to run
 * the pipeline once, not to authenticate from here.
 */
async function connect(): Promise<GramJSClient> {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not set — see .env.example');
  }
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

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/**
 * Refuses to write into a database this exporter did not create.
 *
 * This guard is not hypothetical. A pre-existing archive — say one converted
 * from a Telegram Desktop JSON export — has a far richer `messages` table than
 * the one below, so `CREATE TABLE IF NOT EXISTS` would quietly skip creation
 * and then append into the real thing. Worse, such a table has no
 * `UNIQUE (chat_id, message_id)`, so `INSERT OR IGNORE` would not dedupe and a
 * rerun would multiply rows. The tell that a file is ours is `export_state`,
 * which only this script creates.
 */
function assertOwnArchive(outPath: string): void {
  if (!fs.existsSync(outPath)) return;
  const probe = new DatabaseSync(outPath, { readOnly: true });
  try {
    const row = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'export_state'")
      .get();
    if (!row) {
      throw new Error(
        `${outPath} already exists and was not created by this exporter ` +
          '(no export_state table). Refusing to write into it — appending to a ' +
          'foreign schema would duplicate rows rather than update them.\n' +
          'Pass --out=<new path> to export somewhere else.'
      );
    }
  } finally {
    probe.close();
  }
}

/**
 * Only the columns `discover` reads, plus `export_state` for resumability.
 * Deliberately not the full Telegram-export schema: every extra column would
 * be an unread copy of someone's private messages sitting on disk.
 */
function openArchive(outPath: string): SqliteDb {
  assertOwnArchive(outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const db = new DatabaseSync(outPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id           INTEGER PRIMARY KEY,
      telegram_id  INTEGER NOT NULL,
      name         TEXT,
      type         TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id            INTEGER NOT NULL REFERENCES chats(id),
      message_id         INTEGER NOT NULL,
      date               TEXT NOT NULL,
      text               TEXT,
      is_forwarded       INTEGER DEFAULT 0,
      forwarded_from     TEXT,
      forwarded_from_id  TEXT,
      UNIQUE (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE TABLE IF NOT EXISTS export_state (
      chat_id         INTEGER PRIMARY KEY REFERENCES chats(id),
      max_message_id  INTEGER NOT NULL,
      last_export     TEXT NOT NULL
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

/**
 * Telegram's type model mapped onto the export vocabulary `discover` expects.
 * The megagroup/broadcast split matters: a megagroup is a supergroup (people
 * talking) and a broadcast is a channel (one voice), and discovery treats them
 * differently — channels are the scarce, valuable kind.
 */
function classifyDialog(entity: Api.TypeChat | Api.TypeUser, isSelf: boolean): string | null {
  if (isSelf) return 'saved_messages';
  if (entity instanceof Api.User) return entity.bot ? null : 'personal_chat';
  if (entity instanceof Api.Chat) return 'private_group';
  if (entity instanceof Api.Channel) {
    return entity.megagroup ? 'private_supergroup' : 'channel';
  }
  return null;
}

function dialogTitle(entity: Api.TypeChat | Api.TypeUser): string {
  if (entity instanceof Api.User) {
    return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || 'unknown';
  }
  const titled = entity as { title?: string };
  return titled.title ?? 'unknown';
}

/**
 * The export's `channel<id>` / `user<id>` shape, which the forward-graph query
 * filters on with LIKE 'channel%'. Anything else is left null rather than
 * guessed — a wrong prefix would quietly pollute the channel candidate pool.
 */
function forwardedFromId(fwd: Api.MessageFwdHeader): string | null {
  const peer = fwd.fromId;
  if (peer instanceof Api.PeerChannel) return `channel${peer.channelId}`;
  if (peer instanceof Api.PeerUser) return `user${peer.userId}`;
  if (peer instanceof Api.PeerChat) return `chat${peer.chatId}`;
  return null;
}

/** The export's date format: local-ish ISO with no zone suffix. */
function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 19);
}

function monthsAgoUnix(months: number): number {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return Math.floor(d.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

interface Flags {
  out?: string;
  months?: string;
  'max-calls'?: string;
  'dialog-limit'?: string;
  'include-personal'?: string;
  'dry-run'?: string;
}

/**
 * Accepts both `--key=value` and a bare `--key`, matching discover-sources.ts —
 * the natural thing to type is `--dry-run`, and a parser that recognised only
 * the `=` form would silently ignore it.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags[body] = 'true';
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return flags;
}

async function run(flags: Record<string, string>): Promise<void> {
  /**
   * Deliberately NOT defaulting to $TELEGRAM_ARCHIVE_DB. That variable names the
   * archive discovery *reads*, which may well be one you made another way, and
   * defaulting a writer to it would point this script at a file it must not
   * touch. Export here, then set the variable if you want discovery to use it.
   */
  const outPath = path.resolve(process.cwd(), flags.out ?? 'debug/telegram-archive.db');
  const months = flags.months ? parseInt(flags.months, 10) : DEFAULT_MONTHS;
  const sinceUnix = monthsAgoUnix(months);
  const budget = new CallBudget(flags['max-calls'] ? parseInt(flags['max-calls'], 10) : DEFAULT_MAX_CALLS);
  const dialogLimit = flags['dialog-limit'] ? parseInt(flags['dialog-limit'], 10) : undefined;
  const dryRun = flags['dry-run'] === 'true';

  /**
   * Private chats are off by default. They are the bulk of a dialog list and
   * the most sensitive thing in it, and discovery cannot act on them anyway —
   * `personal_chat` is in NOT_ADDABLE_TYPES, so an event-dense DM is only ever
   * reported as "follow the channel behind this instead". Opt in with
   * --include-personal if you want that hint; the default is not to copy
   * thousands of private conversations to disk for a hint.
   */
  const includePersonal = flags['include-personal'] === 'true';

  console.log(`Export window: last ${months} months (since ${new Date(sinceUnix * 1000).toISOString().slice(0, 10)})`);
  console.log(`Archive: ${outPath}`);
  console.log(`Private chats: ${includePersonal ? 'included' : 'skipped (--include-personal to include)'}`);
  console.log(`Call budget: ${flags['max-calls'] ?? DEFAULT_MAX_CALLS}\n`);

  // Before connecting: a refusal to write should cost no network call, and
  // finding out after getDialogs that the target is unusable is just a wasted
  // call against the flood budget.
  assertOwnArchive(outPath);

  const client = await connect();
  let db: SqliteDb | null = null;

  try {
    const me = await client.getMe();
    const selfId = (me as Api.User).id?.toString();

    const dialogs = await budget.run('getDialogs', () => client.getDialogs({ limit: dialogLimit }));
    if (!dialogs) throw new Error('Could not list dialogs.');
    console.log(`${dialogs.length} dialogs\n`);

    if (dryRun) {
      const counts = new Map<string, number>();
      for (const d of dialogs) {
        const entity = d.entity;
        if (!entity) continue;
        const kind = classifyDialog(entity, entity.id?.toString() === selfId);
        if (!kind) continue;
        if (kind === 'personal_chat' && !includePersonal) continue;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      console.log('Would export:');
      for (const [kind, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${kind}`);
      console.log('\nDry run — no archive written, no history fetched.');
      return;
    }

    db = openArchive(outPath);
    const upsertChat = db.prepare(
      'INSERT INTO chats (id, telegram_id, name, type) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type'
    );
    const insertMessage = db.prepare(
      'INSERT OR IGNORE INTO messages ' +
        '(chat_id, message_id, date, text, is_forwarded, forwarded_from, forwarded_from_id) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const readState = db.prepare('SELECT max_message_id FROM export_state WHERE chat_id = ?');
    const writeState = db.prepare(
      'INSERT INTO export_state (chat_id, max_message_id, last_export) VALUES (?, ?, ?) ' +
        'ON CONFLICT(chat_id) DO UPDATE SET max_message_id = excluded.max_message_id, ' +
        'last_export = excluded.last_export'
    );

    const stamp = new Date().toISOString();
    let chatsSeen = 0;
    let messagesWritten = 0;
    let chatsSkipped = 0;
    let budgetStopped = false;

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!entity || entity.id === undefined) continue;

      const isSelf = entity.id.toString() === selfId;
      const kind = classifyDialog(entity, isSelf);
      if (!kind) continue;
      if (kind === 'personal_chat' && !includePersonal) {
        chatsSkipped += 1;
        continue;
      }

      const telegramId = Number(entity.id.toString());
      const title = dialogTitle(entity);
      upsertChat.run(telegramId, telegramId, title, kind);
      chatsSeen += 1;

      if (budget.exhausted) {
        budgetStopped = true;
        continue;
      }

      const prior = readState.get(telegramId);
      const minId = prior ? Number(prior.max_message_id) : 0;
      let maxSeen = minId;
      let written = 0;
      let offsetId = 0;
      let reachedWindow = false;

      // Pages backwards from newest until the window ends, the incremental
      // floor is reached, or the budget runs out.
      while (!reachedWindow && !budget.exhausted) {
        const page = await budget.run(`history:${title}`, () =>
          client.getMessages(entity, { limit: PAGE_SIZE, offsetId, minId: minId || undefined })
        );
        if (!page || page.length === 0) break;

        for (const msg of page) {
          if (!(msg instanceof Api.Message)) continue;
          if (msg.date < sinceUnix) {
            reachedWindow = true;
            continue;
          }
          const fwd = msg.fwdFrom;
          insertMessage.run(
            telegramId,
            msg.id,
            formatDate(msg.date),
            msg.message ?? null,
            fwd ? 1 : 0,
            fwd?.fromName ?? null,
            fwd ? forwardedFromId(fwd) : null
          );
          written += 1;
          if (msg.id > maxSeen) maxSeen = msg.id;
        }

        const last = page[page.length - 1];
        if (!last || page.length < PAGE_SIZE) break;
        offsetId = last.id;
      }

      if (maxSeen > minId) writeState.run(telegramId, maxSeen, stamp);
      messagesWritten += written;
      if (written > 0) console.log(`  ${kind.padEnd(19)} ${title} — ${written} messages`);
    }

    console.log(`\n${chatsSeen} chats, ${messagesWritten} new messages, ${budget.spent} calls`);
    if (chatsSkipped > 0) {
      console.log(`${chatsSkipped} private chats skipped — pass --include-personal to export them.`);
    }
    if (budgetStopped || budget.exhausted) {
      console.log(
        '\nCall budget reached — the export is INCOMPLETE. It is resumable: ' +
          'rerun to continue from where it stopped, or raise --max-calls.'
      );
    }
    console.log(`\nWrote ${outPath}`);
    console.log('Set TELEGRAM_ARCHIVE_DB to that path, then run:');
    console.log('  npx ts-node scripts/discover-sources.ts discover');
  } finally {
    db?.close();
    await client.disconnect();
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(
      'Usage: npx ts-node scripts/export-telegram.ts [options]\n\n' +
        '  --out=<path>         archive path (default: debug/telegram-archive.db)\n' +
        `  --months=N           how far back to export (default: ${DEFAULT_MONTHS})\n` +
        `  --max-calls=N        MTProto call cap (default: ${DEFAULT_MAX_CALLS})\n` +
        '  --dialog-limit=N     only look at the N most recent dialogs\n' +
        '  --include-personal   also export private chats (off by default)\n' +
        '  --dry-run            report what would be exported, fetch nothing\n'
    );
    return;
  }
  await run(flags);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
