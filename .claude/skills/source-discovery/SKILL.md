---
name: source-discovery
description: Find, verify, add and prune Telegram sources for the event digest end to end - mine the local archive for candidates, expand them through Telegram's own recommendation and shared-folder endpoints, resolve each one live to settle its type and catch duplicates, write the survivors into config.yaml, and comment out sources that have produced nothing across several runs. Use when asked to find new sources, add a channel or group, grow or refresh the source list, or drop dead sources.
---

# Source discovery

Six steps. Steps 1–4 grow the list, step 6 shrinks it; skipping 6 is how the
GPT bill grows without the digest improving. Run everything from the repo root.

## The two failures this pipeline exists to prevent

1. **Wrong bucket.** The cost depends on the entry form, and the difference
   matters when you read a report:
   - A **display-name** entry is matched against `dialog.isGroup` /
     `dialog.isChannel`, so one in the wrong list matches no dialog and fetches
     nothing on every run, forever, with nothing in the logs saying why. This
     has happened in practice and went unnoticed for months — there is no
     symptom to notice.
   - An **`@handle`** entry resolves by username with no type check at all, so a
     wrong bucket is not fatal: it applies the wrong message limit
     (`maxGroupMessages` 200 vs `maxChannelMessages` 50) and files the source
     under the wrong cache-key prefix, skewing yield accounting. `add` only
     writes handles, so this is the case it can cause — still worth getting
     right, since it is a 4x difference in how much of the source is read.
2. **Hidden duplicate.** A config entry is either an `@handle` or a display
   name, and only the *resolved* name is comparable — `"Musicians in Tbilisi"`
   and `"@musicians_in_tbilisi"` are one chat wearing two labels. The pipeline
   caches under `username`-or-`c/<id>`, so that resolved identity is the only
   sound basis for "already monitored".

Neither is knowable offline. That is why **step 3 is not optional** and why
`add` refuses to write anything step 3 has not resolved.

## Run alone

Steps 2, 3 and 5 all open `.telegram-session`. **Never run them concurrently
with each other or with a digest run** — two clients on one session invite
trouble. Step 1 and steps 4/6 are offline and safe any time.

Flood policy: every MTProto call is spaced 2.5s, capped per run
(`--max-calls`, default 40), and the first `FLOOD_WAIT` aborts the command
outright. **If a command aborts on FLOOD_WAIT, stop the whole run and say so.**
Do not rerun it — retrying is how a short ban becomes a long one. The unfinished
candidates are reported as `unattempted`; pick them up on a later day.

## Step 1 — Mine the archive (offline)

```bash
npx ts-node scripts/discover-sources.ts discover [--since=YYYY-MM-DD] [--limit=25]
```

Reads a local Telegram export and writes ranked candidates to
`debug/discovered-sources.yaml`. No network, no config write.

The export path has **no default** — set `TELEGRAM_ARCHIVE_DB` in `.env` or
pass `--db=<path>`. If you have no export yet, step 0 makes one:

```bash
npx ts-node scripts/export-telegram.ts [--out=<path>] [--months=12]
```

That is the only network step outside 2/3/5, and it obeys the same flood
policy. It writes a SQLite archive of your own dialogs and their recent
messages; nothing leaves the machine.

Coverage limit worth stating when you report: an export is mostly private chats
and groups, with very few channels — Telegram gives you your own dialog list,
and most people are in far more groups than channels. So step 1 sees **groups**
well and **channels** barely at all. For channels the real routes are the
forward/link pools here and `similar` in step 2. Report the actual chat/channel
split the run prints, rather than assuming it.

If the archive is missing, skip to step 2 — it needs no archive except for
`folders`.

## Step 2 — Expand through Telegram's own graph (network, alone)

```bash
npx ts-node scripts/expand-sources.ts similar [--seeds=a,b] [--max-calls=40]
npx ts-node scripts/expand-sources.ts folders [--max-calls=40]
npx ts-node scripts/expand-sources.ts resolve [--max-calls=40]
```

Each appends a section to `debug/expanded-sources.yaml`:

| Command | Source of candidates | Precision |
|---|---|---|
| `similar` | subscriber-overlap recommendations over your configured channels | medium — finds channels sharing an audience without sharing vocabulary; truncated without Premium |
| `folders` | shared-folder contents, from `addlist` hashes found in step 1 | highest — a human curated each bundle |
| `resolve` | forward-graph channel IDs → `@handles` | mostly a free session-cache lookup |

`folders` needs step 1's report. The other two do not. Run whichever the
call budget allows; all three feed the same candidate pool.

## Step 3 — Verify (network, alone) — the gate

```bash
npx ts-node scripts/expand-sources.ts verify [--candidates=a,b] [--max-calls=40]
```

Collects every `@handle` from both reports, or just the ones in
`--candidates`, and resolves each one live. One `getDialogs` call first resolves
every display-name config entry to its cache identity, which is what makes the
duplicate check exact rather than a string comparison.

Each candidate lands in exactly one of three places in the `verified` section:

- **addable** — resolved, typed, not already monitored. Carries its bucket,
  title, kind and member count.
- **rejected** — with the reason: already in config by handle, already monitored
  under another label, a user rather than a chat, or did not resolve.
- **unattempted** — the call budget ran out first. Rerun later to continue.

It also writes `config_identity_map`, which is how the offline `prune` in step 6
ties a cache source name back to a display-name config entry. **Run `verify` at
least once before relying on step 6**, or every display-name entry shows up as
unmappable.

## Step 4 — Add (offline, writes config.yaml)

```bash
npx ts-node scripts/discover-sources.ts add [--dry-run]
```

Writes only what step 3 marked addable, into the bucket step 3 resolved, with a
dated provenance comment. The edit is textual so the file's comments survive —
a js-yaml round trip would delete the interest taxonomy, the batch-size
rationale and every provenance note without a word.

Three guards, all worth mentioning if one fires:

- **Backup first.** `config.yaml*` is gitignored, so git cannot undo this. The
  backup is `config.yaml.bak-<stamp>`, covered by the same ignore rule.
- **Staleness.** A `verified` section older than 72h is refused: it asserts what
  is already monitored, and config.yaml may have changed since. Re-run step 3.
  `--force` overrides, but prefer re-verifying.
- **Idempotency.** A handle already anywhere in the file is never written twice.

Say this when you report: each new source starts with an empty cache, so the
next run fetches its **whole window** and pays GPT for all of it. The run after
that is incremental.

## Step 5 — Run the digest

```bash
npm run dev
```

Nothing about a new source is known until it has actually run. This is also what
produces the evidence step 6 needs.

## Step 6 — Prune (offline, writes config.yaml)

```bash
npx ts-node scripts/discover-sources.ts prune [--dry-run]
```

Run this **after each digest run**. Every invocation records a yield
observation to `.cache/source_yield_history.json` and judges only on the
accumulated history — a single snapshot cannot tell a dead source from a quiet
week. A source needs **3 observations** before any verdict, and it is
**commented out, never deleted**: the line is the only record that the source
was tried, and a deleted one gets rediscovered and re-added on the next sweep.

Two verdicts, with different causes and different evidence:

- **dead** — fetched messages, produced no surviving events across every
  observation. The source is real but off-topic. Counted from the message cache.
- **silent** — left no cache entry at all. Unresolvable, or a display-name entry
  in the wrong bucket. This one cannot be counted from the cache: an
  unresolvable source returns early before its cache key is computed, so it
  leaves no trace, and silence has to be inferred from the *config* side. That
  is why each observation records the config list in effect at the time — an
  entry is only blamed for runs it was actually configured for. Check the bucket
  before writing a silent source off.

Both need a resolved identity to map a cache source back to a config entry, so
**`verify` must have run at least once** or display-name entries are reported as
unmappable rather than judged.

Running `prune` twice without a digest run in between records nothing and says
so — otherwise three invocations would manufacture three runs' worth of
evidence from one run.

## Never delete

- **`.cache/telegram_messages.json`** — re-fetching every source is slow and
  risks FLOOD_WAIT.
- **`.cache/resolved_entities.json`** — deleting it re-resolves every channel
  and triggers the ResolveUsername flood it exists to prevent.
- **`.cache/source_yield_history.json`** — the prune evidence. Losing it resets
  every source's zero-yield history to nothing, which is indistinguishable from
  every source being healthy.
- **`config.yaml.bak-*`** — the only way back from a bad `add` or `prune`.

Clearing the five GPT stores (`messages`, `event_type_classification`,
`scheduled_events`, `matching_interests`, `events`) is fine and unrelated.

## Reporting the result

State, in this order:

1. How many candidates each route produced, and which routes you actually ran.
2. What `verify` resolved: added per bucket with titles, and the rejections
   **with their reasons** — "3 rejected" hides the useful part, which is
   whether they were duplicates, dead handles or the wrong entity type.
3. Anything left `unattempted` by the call budget, by name.
4. What `prune` did, with the observation count behind each verdict. A prune
   verdict without its run count is unreadable: zero events over 3 runs is a
   finding, zero over 1 is noise.
5. The backup filename, if config.yaml was written.

Never present a candidate as a good source because it scored well in step 1.
Archive cues predict event density; only step 6's yield measures it. Say
"untested" until it has run.

## Do not, unless asked

- Do not join groups or channels. Every command here reads; none joins.
- Do not rerun a network command that hit its call budget in the same session —
  that is what `unattempted` is for.
- Do not delete previous `debug/*-sources.yaml` reports to "get a clean run".
- Do not tune the scoring weights as part of a discovery run.

## If something looks wrong

```bash
npx ts-node scripts/discover-sources.ts validate   # is the scorer still sane?
npx ts-node scripts/discover-sources.ts yield      # per-source yield, read-only
npx ts-node scripts/discover-sources.ts add --dry-run
npx ts-node scripts/discover-sources.ts prune --dry-run
```

`validate` can only catch a badly broken or inverted scorer — config.yaml was
assembled for topical interest, not event density, so "is configured" is a
confounded label and sitting near chance is the expected result, not a failure.

A source in config.yaml that fetches nothing is almost always the wrong bucket.
Confirm with `verify --candidates=<handle>`, which prints the type it actually
resolves to.
