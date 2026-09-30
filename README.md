# Event Digest CLI

A TypeScript CLI tool that generates personalized event digests from Telegram groups and channels using AI-powered filtering.

## Overview

This tool fetches messages from specified Telegram groups and channels, then uses a multi-step AI filtering pipeline to extract events that match your interests and schedule preferences.

## Features

- **YAML Configuration**: Easy-to-manage configuration files with organized settings
- **Clean Architecture**: Domain-Driven Design with clear separation of concerns
- **Smart Event Detection**: Uses GPT to identify genuine event announcements vs general messages
- **Event Type Classification**: Classifies events as offline, online, or hybrid with intelligent location detection
- **Location Filtering**: Extracts the venue and address, and optionally keeps only events in the places you name
- **High-Accuracy Interest Matching**: Comprehensive GPT guidelines with mandatory matching rules and validation to prevent hallucinated interests
- **Confidence Scoring**: Configurable threshold (default 0.75) ensures only high-quality interest matches
- **Schedule Integration**: Filters events by your availability (day of week + time slots), keeping date-known/time-unknown events as "(time TBA)"
- **Deduplication**: Collapses the same event reposted by several sources into one entry, linking the earliest posting
- **Add to Calendar**: Every event carries a Google Calendar prefill link — no API key, OAuth or setup
- **Online Event Filtering**: Option to skip online-only events while including hybrid events
- **Persistent Authentication**: Automatic Telegram session management after initial setup
- **Intelligent Caching**: Seven-tier caching system reduces API costs by caching both Telegram messages and GPT results with preference-aware keys
- **Incremental Message Fetching**: Uses minId parameter to fetch only messages with ID greater than last cached message ID
- **Multi-Language Support**: Handles events in different languages with configurable cues
- **Debug Mode**: Optional detailed debug files for troubleshooting and analysis
- **Configurable Batch Processing**: Tune GPT batch sizes for optimal speed/accuracy balance
- **Event Delivery**: Send events directly to Telegram recipients or print to console
- **Source Discovery**: Tooling to grow the source list rather than guess at it — export your dialogs, mine them for candidates, expand through Telegram's own recommendation and shared-folder endpoints, verify each one live, then prune what never yields. See [Finding Sources](#finding-sources)

## Prerequisites

1. **Telegram API Credentials**: Get from [my.telegram.org](https://my.telegram.org)
2. **OpenAI API Key**: Get from [platform.openai.com](https://platform.openai.com)

## Installation

```bash
git clone <repository-url>
cd event-digest
npm install
```

## Configuration

### Environment Variables

Create a `.env` file (use `.env.example` as template):

```env
TELEGRAM_API_ID=your_api_id_here
TELEGRAM_API_HASH=your_api_hash_here
TELEGRAM_PHONE_NUMBER=your_phone_number_here
OPENAI_API_KEY=your_openai_api_key_here
```

Optional, and only read by the source-discovery scripts — the digest runs fine without it:

```env
# Path to a local Telegram archive, mined to suggest new sources.
# There is no default: an export lives wherever you put it, usually outside
# this repo. See "Finding Sources" below for how to create one.
TELEGRAM_ARCHIVE_DB=/path/to/telegram.db
```

### Configuration Options

You can configure the tool in multiple ways. **Command-line arguments always override YAML configuration values.**

#### Option 1: YAML Configuration (Recommended)

Create a `config.yaml` file in the project root:

```yaml
# Telegram channels to monitor
# Supports: @username (direct lookup), or "Display Name" (searches your joined channels)
channelsToParse:
  - "@city_events"
  - "Local Announcements"
  - "Private Event Channel"  # Display name search works for both public and private

# Telegram groups to monitor
# Supports: @username (direct lookup), or "Display Name" (searches your joined groups)
groupsToParse:
  - "@tech_meetups"
  - "Community Events"
  - "My Private Group"  # Display name search works for both public and private

# Your interests - events will be matched against these topics
# Use specific, focused interests for best accuracy
# Parentheses are for clarification, NOT for OR matching alternatives
# Events must explicitly match the specific interest topic
userInterests:
  - "React and Frontend development"
  - "Street photography"
  - "Portrait photography"
  - "Board games and tabletop gaming (strategy games, D&D sessions)"
  - "Professional networking events (Tech industry)"
  - "Jazz music and jazz concerts"
# See config.example.yaml for detailed tips and examples

# Weekly availability timeslots
# Format: "DAY_OF_WEEK TIME" where DAY_OF_WEEK is 0-6 (0=Sunday, 6=Saturday)
weeklyTimeslots:
  - "6 14:00"  # Saturday after 14:00
  - "0 14:00"  # Sunday after 14:00

# Maximum number of messages to fetch from groups
# Default: 200 (when only this value is unspecified but maxChannelMessages is specified)
#          800 (when both limits unspecified: base value 200 is multiplied by GROUP_MESSAGE_MULTIPLIER=4.0)
maxGroupMessages: 200

# Maximum number of messages to fetch from channels
# Default: 100 (when maxGroupMessages is specified)
#          200 (when both limits unspecified, from the legacy maxInputMessages path)
maxChannelMessages: 100

# Skip online-only events (default: true)
# Hybrid events (both online and offline options) are always included
skipOnlineEvents: true

# Write debug files (default: false)
# When enabled, writes detailed debug files to debug/ directory
writeDebugFiles: false

# Verbose logging (default: false)
# When enabled, prints detailed processing information including cache stats,
# batch numbers, DISCARDED messages with links, and event creation status
verboseLogging: false

# Keep events whose date is known but whose time is not (default: true)
# Shown as "27 Sep 2026 (time TBA)"; they bypass the weeklyTimeslots check
includeEventsWithoutTime: true

# Collapse the same event announced by several sources (default: true)
deduplicateEvents: true

# Places whose events you want (default: empty, meaning no filtering)
# The venue and address are extracted for display either way
locationFilter:
  - "Tbilisi"

# Keep events whose announcement named no place at all (default: true)
# Turning this off also drops every online event, which has no venue to match
includeEventsWithoutLocation: true

# Minimum confidence thresholds for AI filtering (0.0-1.0)
# GPT assigns confidence scores to predictions; only results above threshold are included

# Minimum confidence for event detection (default: 0.7)
# Controls which messages are classified as events
minEventDetectionConfidence: 0.7

# Minimum confidence for event type classification (default: 0.7)
# Controls confidence in offline/online/hybrid classification
# Applied on read, so retuning it re-judges cached verdicts with no GPT calls
minEventClassificationConfidence: 0.7

# Minimum confidence for the location match (default: 0.7)
# Applied on read, so retuning it re-judges cached results with no GPT calls
minLocationConfidence: 0.7

# Minimum confidence for interest matching (default: 0.75)
# GPT assigns 0.0-1.0 confidence scores to each interest match
# Only matches with confidence ≥ this threshold are included
minInterestConfidence: 0.75

# GPT batch sizes for processing (optional)
# Controls how many items are processed in each GPT API call
# Larger batches are faster but may reduce accuracy
eventDetectionBatchSize: 16      # Step 3: Event detection
eventClassificationBatchSize: 16 # Step 4: Event type classification
scheduleExtractionBatchSize: 16  # Step 5: Schedule extraction
locationExtractionBatchSize: 16  # Step 6: Location extraction
eventDescriptionBatchSize: 3     # Step 9: Event description generation

# Reasoning effort for GPT calls (default: low)
# One of: none, low, medium, high, xhigh
# Higher effort spends more reasoning tokens before the visible answer, which costs
# more and can truncate steps that emit one output block per input message.
reasoningEffort: low

# Optional per-step overrides; each falls back to reasoningEffort above
# eventDetectionReasoningEffort: none
# eventClassificationReasoningEffort: none
# scheduleExtractionReasoningEffort: low
# locationExtractionReasoningEffort: low
# interestMatchingReasoningEffort: low
# eventDescriptionReasoningEffort: low

# Optional: Send events to Telegram recipient instead of printing to console
# Format: @username or chat ID (e.g., -1001234567890)
# If not set, events are printed to console (default behavior)
sendEventsRecipient: "@myusername"

# Number of events to send per message batch (default: 5)
sendEventsBatchSize: 5

# Optional: Custom GPT prompts for AI filtering steps
# See config.example.yaml for detailed placeholder docs and examples
# eventDetectionPrompt: |
#   Identify which messages are single event announcements...
# interestMatchingPrompt: |
#   Match events to interests...
# eventTypeClassificationPrompt: |
#   Classify events as offline/online/hybrid...
```

Then run:
```bash
npm run dev
```

#### Option 2: Custom YAML File

```bash
npm run dev -- --config=my-config.yaml
```

#### Option 3: Command Line Arguments

```bash
npm run dev -- \
  --groups "tech_meetups,community_events" \
  --channels "city_events,local_announcements" \
  --interests "Technology,Music,Photography" \
  --timeslots "2 12:00,6 13:00,0 13:00" \
  --location-filter "Tbilisi" \
  --max-group-messages 200 \
  --max-channel-messages 100 \
  --skip-online-events true \
  --write-debug-files false \
  --verbose-logging false \
  --include-events-without-time true \
  --include-events-without-location true \
  --deduplicate-events true \
  --min-event-detection-confidence 0.7 \
  --min-event-classification-confidence 0.7 \
  --min-location-confidence 0.7 \
  --min-interest-confidence 0.75 \
  --event-detection-batch-size 16 \
  --event-classification-batch-size 16 \
  --schedule-extraction-batch-size 16 \
  --location-extraction-batch-size 16 \
  --event-description-batch-size 3 \
  --reasoning-effort low \
  --event-detection-reasoning-effort none \
  --send-events-recipient "@myusername" \
  --send-events-batch-size 5
```

#### Option 4: Mix YAML and CLI (Override Specific Values)

Load YAML config and override specific parameters via command line:

```bash
# Use config.yaml but enable verbose logging for this run
npm run dev -- --verbose-logging true

# Use config.yaml but change batch sizes for testing
npm run dev -- --event-detection-batch-size 8 --verbose-logging true
```

### Interest Matching Best Practices

The tool uses AI to match events to your interests with confidence scoring. For best results:

**Be Specific and Explicit**
- ❌ Too broad: `"Technology"`, `"Music"`, `"Sports"`
- ✅ Specific: `"React development"`, `"Jazz concerts"`, `"Trail running"`
- Events must explicitly mention the interest to match

**Use Parentheses for Clarification Only**
- Format: `"Main interest (clarifying details)"`
- Example: `"Abstract Hip Hop (instrumental/experimental beats)"`
- Parentheses explain WHAT the interest is, NOT alternative match options
- The event must be about "Abstract Hip Hop" specifically

**Break Down Broad Categories**
- ❌ `"Electronic music (various subgenres)"` - expects OR matching (won't work)
- ✅ Create separate specific interests:
  - `"Drum and Bass"`
  - `"Electro Swing"`
  - `"Big Beat"`
- Each event is matched against specific subgenres only

**Distinguish Context**
- ❌ Unclear: `"Networking"`
- ✅ Clear: `"Professional networking events (Tech industry)"` vs `"Social gatherings"`

**Separate Similar Interests**
- Consumption vs Creation: `"Music concerts"` vs `"Music production workshops"`
- Different stacks: `"React development"` vs `"Python development"`

**Use EXCLUDE Markers (Optional)**
- `"Neural mechanisms — EXCLUDE: nutrition, wellness, general psychology"`
- Events matching excluded topics will be rejected

**Debug Your Matches**
- Enable `writeDebugFiles: true` to generate `debug/interest_matching.json`
- Review confidence scores and adjust interests for better precision
- Only matches with confidence ≥ `minInterestConfidence` (default: 0.75) are included

See `config.example.yaml` for more examples and detailed guidance.

### Configuration Parameters

- `groupsToParse`/`--groups`: Telegram groups - supports @username (direct lookup) or "Display Name" (searches joined groups)
- `channelsToParse`/`--channels`: Telegram channels - supports @username (direct lookup) or "Display Name" (searches joined channels)
- `userInterests`/`--interests`: Your interests (events must be directly about these topics)
- `weeklyTimeslots`/`--timeslots`: Available time slots in format "DAY HOUR:MINUTE" (0=Sunday, 6=Saturday)
- `maxGroupMessages`/`--max-group-messages`: Maximum messages to fetch per group (default: 200, or 800 if both limits unspecified)
- `maxChannelMessages`/`--max-channel-messages`: Maximum messages to fetch per channel (default: 100, or 200 if both limits unspecified)
- `skipOnlineEvents`/`--skip-online-events`: Skip online-only events, keep hybrid events (default: true)
- `writeDebugFiles`/`--write-debug-files`: Enable debug file output to debug/ directory (default: false)
- `verboseLogging`/`--verbose-logging`: Enable detailed logging with cache stats, batch numbers, and DISCARDED message links (default: false)
- `includeEventsWithoutTime`/`--include-events-without-time`: Keep events whose date is known but whose time is not, shown as "27 Sep 2026 (time TBA)"; they bypass the `weeklyTimeslots` check (default: true)
- `includeEventsWithoutLocation`/`--include-events-without-location`: Keep events whose announcement named no place at all; turning this off also drops every online event, since a virtual event has no venue to match (default: true)
- `locationFilter`/`--location-filter`: Places whose events you want, e.g. `["Tbilisi"]`; empty means no filtering, though the venue and address are still extracted for display (default: empty)
- `deduplicateEvents`/`--deduplicate-events`: Collapse the same event announced by several sources into one entry, by word overlap on the source posts (default: true)
- **Confidence Thresholds** (optional - controls AI quality filtering):
  - `minEventDetectionConfidence`/`--min-event-detection-confidence`: Minimum confidence (0.0-1.0) for event detection; higher values = fewer but more certain events (default: 0.7)
  - `minEventClassificationConfidence`/`--min-event-classification-confidence`: Minimum confidence (0.0-1.0) for event type classification; higher values = stricter classification (default: 0.7)
  - `minLocationConfidence`/`--min-location-confidence`: Minimum confidence (0.0-1.0) for the step 6 location match (default: 0.7)
  - `minInterestConfidence`/`--min-interest-confidence`: Minimum confidence (0.0-1.0) for interest matching; higher values = fewer but more certain matches (default: 0.75)
- **GPT Batch Sizes** (optional - controls processing efficiency):
  - `eventDetectionBatchSize`/`--event-detection-batch-size`: Items per batch for event detection (default: 16)
  - `eventClassificationBatchSize`/`--event-classification-batch-size`: Items per batch for event type classification (default: 16)
  - `scheduleExtractionBatchSize`/`--schedule-extraction-batch-size`: Items per batch for schedule extraction (default: 16)
  - `locationExtractionBatchSize`/`--location-extraction-batch-size`: Items per batch for location extraction (default: 16)
  - `eventDescriptionBatchSize`/`--event-description-batch-size`: Items per batch for event description generation (default: 3)
- **Reasoning Effort** (optional - trades accuracy against cost and latency):
  - `reasoningEffort`/`--reasoning-effort`: Effort for every GPT step; one of `none`, `low`, `medium`, `high`, `xhigh` (default: `low`)
  - Per-step overrides, each falling back to `reasoningEffort`: `eventDetectionReasoningEffort`/`--event-detection-reasoning-effort`, `eventClassificationReasoningEffort`/`--event-classification-reasoning-effort`, `scheduleExtractionReasoningEffort`/`--schedule-extraction-reasoning-effort`, `locationExtractionReasoningEffort`/`--location-extraction-reasoning-effort`, `interestMatchingReasoningEffort`/`--interest-matching-reasoning-effort`, `eventDescriptionReasoningEffort`/`--event-description-reasoning-effort`
  - Changing any of these invalidates the affected step's cache, so only that step re-runs
- **Custom GPT Prompts** (optional, YAML only - all 6 AI steps configurable):
  - `eventDetectionPrompt`: Custom prompt for event detection (step 3) - uses `{{MESSAGES}}` placeholder
  - `eventTypeClassificationPrompt`: Custom prompt for event type classification (step 4) - uses `{{MESSAGES}}` placeholder
  - `scheduleExtractionPrompt`: Custom prompt for datetime extraction (step 5) - uses `{{TODAY_DATE}}`, `{{MESSAGES}}` placeholders
  - `locationExtractionPrompt`: Custom prompt for venue extraction and location matching (step 6) - uses `{{LOCATIONS}}`, `{{MESSAGES}}` placeholders
  - `interestMatchingPrompt`: Custom prompt for interest matching (step 7) - uses `{{EVENTS}}`, `{{INTERESTS}}` placeholders
  - `eventDescriptionPrompt`: Custom prompt for event description generation (step 9) - uses `{{EVENTS}}` placeholder
  - See config.example.yaml for detailed documentation and examples
- `sendEventsRecipient`/`--send-events-recipient`: Telegram recipient for event delivery (e.g., @username or chat ID); when set, events are sent instead of printed (default: none - prints to console)
- `sendEventsBatchSize`/`--send-events-batch-size`: Number of events to send per Telegram message batch (default: 5)
- `maxInputMessages`/`--max-messages`: Legacy parameter for backward compatibility

## Authentication & Session Management

### First Run

On your first run, you'll be prompted to:
1. Enter the verification code sent to your phone
2. Enter your 2FA password (if enabled)

The tool will save your Telegram session to `.telegram-session` file for future use.

### Session Persistence

- **Automatic Login**: After initial setup, the tool uses the saved session for subsequent runs
- **Session Storage**: Session data is securely stored in `.telegram-session` file
- **No Re-authentication**: You won't need to enter codes again unless the session expires
- **Session Management**: The session is saved only after successful login, not on every disconnect

### Private Channels and Groups

The tool supports accessing both public and private channels/groups:

**Direct Username Lookup** (Public only):
- Use `@username` format (@ prefix is required)
- Performs direct lookup via Telegram API
- Fastest method for public channels/groups with usernames

**Display Name Search** (Public and Private):
- Use the display name as shown in Telegram (e.g., "My Private Group")
- Searches through your joined chats to find matching names (case-insensitive, partial match)
- You must be a member of the channel/group for it to appear in search results
- Works for both public and private channels/groups
- The tool loads your dialogs once per run to avoid API rate limits

**Important**: Keep the `.telegram-session` file secure and add it to `.gitignore` to avoid committing sensitive session data.

## Finding Sources

`channelsToParse` and `groupsToParse` are the digest's whole input, and filling
them by hand means remembering every event channel you ever joined. The
`scripts/` directory automates that: it proposes candidates, verifies each one
live, writes the survivors into `config.yaml`, and later comments out the ones
that never produced anything.

Everything here is optional — a hand-written config works fine — and nothing
joins a channel or posts a message. Every command reads.

### Step 0: Create an archive (once)

Candidate mining reads a local SQLite archive of your own dialogs:

```bash
npx ts-node scripts/export-telegram.ts            # writes debug/telegram-archive.db
npx ts-node scripts/export-telegram.ts --dry-run  # report what it would export
```

Then point `TELEGRAM_ARCHIVE_DB` at it in `.env`. Worth knowing:

- **Private chats are excluded by default.** They are most of a dialog list and
  the most sensitive part of it, and mining cannot act on them anyway — a DM is
  never addable as a source. `--include-personal` opts in.
- **It stores only the seven columns the miner reads** — chat name and type,
  message id, date, text, and the three forwarding fields. Nothing else Telegram
  returns is written to disk.
- **It is incremental and resumable.** A full sweep is thousands of API calls,
  so it will likely stop at the call budget; rerun and it continues where it
  stopped. Calls are spaced 2.5s and the first `FLOOD_WAIT` aborts.
- **It will not write into a database it did not create**, so it cannot append
  to an export you made another way.

If you already have a Telegram export in this schema, skip step 0 and point
`TELEGRAM_ARCHIVE_DB` at it.

### Steps 1–4: Propose, verify, add

```bash
npx ts-node scripts/discover-sources.ts discover   # rank candidates from the archive (offline)
npx ts-node scripts/expand-sources.ts similar      # channels sharing your channels' audience
npx ts-node scripts/expand-sources.ts folders      # contents of shared folders you were sent
npx ts-node scripts/expand-sources.ts verify       # resolve each candidate live  ← required
npx ts-node scripts/discover-sources.ts add        # write the survivors to config.yaml
```

`verify` is not optional, and `add` refuses to write anything it has not
resolved. Two things are invisible offline and only a live lookup settles them:
which list an entry belongs in (a display name in the wrong one silently fetches
nothing forever), and whether a candidate is a chat you already monitor under a
different label — `"Musicians in Tbilisi"` and `"@musicians_in_tbilisi"` are one
chat wearing two names.

`add` backs `config.yaml` up first, and edits it textually so its comments
survive. Each new source starts with an empty cache, so the next run fetches its
whole window and pays for all of it; the run after that is incremental.

### Step 6: Prune

```bash
npm run dev                                       # produce evidence
npx ts-node scripts/discover-sources.ts prune     # comment out what never yields
```

Run `prune` after digest runs. It needs **3 observations** before judging
anything, because one quiet week is not a dead source, and it comments sources
out rather than deleting them — a deleted line gets rediscovered and re-added on
the next sweep. `yield` reports the same numbers read-only.

Skipping this step is how the GPT bill grows without the digest improving.

### Cautions

- `similar`, `folders`, `verify` and a digest run all open `.telegram-session`.
  **Never run two at once.**
- If a command aborts on `FLOOD_WAIT`, stop — do not rerun it. Unfinished
  candidates are reported as `unattempted`; pick them up another day.
- Never delete `.cache/source_yield_history.json` (the prune evidence),
  `.cache/resolved_entities.json` (prevents a resolve flood), or
  `config.yaml.bak-*` (the only way back from a bad `add`).
- A high mining score predicts event density; it does not measure it. A new
  source is **untested** until it has run and been pruned against.

Agent users: `.claude/skills/source-discovery/` is the full runbook.

## How It Works

The tool processes messages through a 9-step pipeline:

Steps 1 and 2 make no AI calls, step 8 makes none either; the other six each call GPT and each has its own cache, batch size, prompt and reasoning effort.

1. **Fetch Messages** (`data/telegram-client.ts`) - Retrieves recent messages from specified Telegram sources, fetching only what is new since the last run and keeping the most recent `maxGroupMessages`/`maxChannelMessages` per source
2. **Event Cue Filter** (`domain/services/event-cues-filter.ts`) - Filters messages containing date/event keywords. Pure text matching, no GPT
3. **AI Event Detection** (`domain/services/event-detector.ts`) - Uses GPT to identify genuine event announcements, creates DigestEvent objects with message field and event_detection_confidence (0.0-1.0 score). The score is cached as returned and `minEventDetectionConfidence` is applied on read
4. **Event Type Classification** (`domain/services/event-classifier.ts`) - Classifies events as offline, online, or hybrid, adds event_type_classification field (type and confidence), then drops online-only events when `skipOnlineEvents` is set. Like step 3, the verdict is cached as returned and `minEventClassificationConfidence` is applied on read
5. **Schedule Filtering** (`domain/services/schedule-matcher.ts`) - Extracts the start with GPT and keeps events that are still upcoming and fall in your time slots. Adds start_datetime and start_time_known: a post that names the day but not the hour is kept when `includeEventsWithoutTime` is set, bypassing the time-slot check and rendering as "(time TBA)"
6. **Location Filtering** (`domain/services/location-matcher.ts`) - Extracts the venue and address with GPT, and when `locationFilter` is set, keeps only events in those places. The match is a model judgement, not a string comparison: a post reading "Fabrika, Egnate Ninoshvili St 8" never names Tbilisi. Adds event_location field (venue, address and the matched location). Runs after step 5 so only date-surviving events are paid for, and before steps 7 and 9 so out-of-area events never reach the two costliest steps
7. **Interest Matching** (`domain/services/interest-matcher.ts`) - Matches events to your specified interests using comprehensive guidelines and validation to prevent hallucinated categories, adds interest_matches field (with confidence scores). Processes events one at a time rather than in batches, for accurate validation
8. **Deduplication** (`domain/services/event-deduplicator.ts`) - Collapses the same event announced by several sources into one entry, keeping the earliest posting and listing the others in duplicate_sources. If the survivor gave no time but a later copy states one, it adopts that time. Uses no GPT calls, and runs before descriptions so duplicates never reach the describer
9. **Event Description** (`domain/services/event-describer.ts`) - Generates structured event descriptions with titles and summaries using GPT, adds event_description field (DigestEventDescription type with title and short_summary)

## Architecture

This codebase follows **Clean Architecture** and **Domain-Driven Design (DDD)** principles:

```
src/
├── domain/                     # Business logic & domain entities
│   ├── entities/               # Domain entities (DigestEvent, SourceMessage, etc.)
│   ├── interfaces/             # Domain interfaces (IAIClient, ICache, IMessageSource)
│   ├── services/               # Business logic services (filtering, matching, etc.)
│   └── constants.ts            # Domain constants (DATETIME_UNKNOWN)
├── application/                # Use case orchestration
│   └── event-pipeline.ts       # 9-step pipeline orchestrator
├── data/                       # External systems (infrastructure layer)
│   ├── openai-client.ts        # OpenAI API client
│   ├── telegram-client.ts      # Telegram API client
│   ├── cache.ts                # Caching system
│   └── entity-cache.ts         # Resolved Telegram entities
├── config/                     # Configuration management
│   ├── types.ts                # Config interface
│   ├── defaults.ts             # Default values & prompts
│   ├── constants.ts            # Config constants (GROUP_MESSAGE_MULTIPLIER)
│   ├── args-parser.ts          # CLI argument parsing
│   ├── yaml-loader.ts          # YAML configuration loading
│   └── validator.ts            # Config validation & merging
├── shared/                     # Shared utilities
│   ├── date-utils.ts           # Date normalization
│   ├── logger.ts               # Logging utilities
│   ├── batch-processor.ts      # Batch processing helpers
│   ├── readline-helper.ts      # Input prompts
│   ├── debug-writer.ts         # Debug file writer
│   └── types/                  # Shared types
│       └── debug-entries.ts    # Debug entry type definitions
├── presentation/               # Output formatting
│   ├── event-reporter.interface.ts  # IEventReporter interface
│   ├── event-printer.ts        # Console event output
│   └── event-sender.ts         # Telegram message sending
└── index.ts                    # Application bootstrap
```

### Key Technologies

- **TypeScript** with strict type checking
- **GramJS** for Telegram API integration
- **OpenAI gpt-6-luna** for intelligent filtering, with configurable reasoning effort
- **date-fns** for date parsing and manipulation
- **js-yaml** for YAML configuration support
- **Comprehensive caching** to minimize API costs

## Output Format

Both reporters list events chronologically and share most of their lines:

- `📅` the start, or `30 Sep 2025 (time TBA)` when the announcement gave a date but no time
- `📍` the venue and address — **omitted entirely** when the post named no place, rather than shown as "unknown"
- `📝` the generated summary
- `➕` a Google Calendar link that opens the create form already filled in (see below)

They differ in two places. The link to the announcement: Telegram can hide a URL behind text, so the
**event title is the link** and there is no separate line for it, while the console prints a `🔗` line
with the URLs spelled out — including the other postings of an event that step 8 collapsed, which the
Telegram output leaves unlinked, since they are copies of what the title already opens. And the `🏷️`
line of matched interests, which only the console shows: it answers what step 7 matched, a question
worth asking while tuning `userInterests` but not while reading a digest of your own choices.

### Add to Calendar

The `➕` line is a [Google Calendar](https://calendar.google.com) prefill link — clicking it opens the
create form with the title, time and location already filled in, and nothing is saved until you
confirm. It needs no API key, no OAuth and no setup, because it is just a URL.

Two things about it are worth knowing:

- Announcements state when an event starts and almost never when it ends, so the link assumes a
  **two-hour** duration. Correct it in the form before saving if that is wrong.
- An event whose time was never stated becomes an **all-day** entry rather than a block at a made-up
  hour, which is the only shape that honestly represents "we know the day, not the time".

### Console Output

When no `sendEventsRecipient` is configured (default behavior), events are printed to console:

```
=== EVENT DIGEST (September 30, 2025) ===

1. Tech Meetup
   📅 30 Sep 2025 19:00
   📍 Impact Hub — Egnate Ninoshvili St 8
   🏷️ Technology
   📝 Monthly meetup for tech enthusiasts to share knowledge and network.
   🔗 https://t.me/tech_meetups/12345, https://t.me/city_events/67891
   ➕ https://calendar.google.com/calendar/render?action=TEMPLATE&text=Tech+Meetup&...

2. Autumn Jam Session
   📅 02 Oct 2025 (time TBA)
   🏷️ Jazz music and jazz concerts
   📝 An open jam session for local musicians; the hour is still to be announced.
   🔗 https://t.me/city_events/67890
   ➕ https://calendar.google.com/calendar/render?action=TEMPLATE&text=Autumn+Jam+Session&...

Total events found: 2
```

Event 1 was announced twice and collapsed into one entry, so both links appear on its `🔗` line. Event 2 shows the two optional cases: no time stated, and no venue named.

### Telegram Message Format

When `sendEventsRecipient` is configured, events are sent as formatted Telegram messages:

```
EVENT DIGEST (September 30, 2025)

1. Tech Meetup                       <- the title is a link to the announcement
📅 30 Sep 2025 19:00
📍 Impact Hub — Egnate Ninoshvili St 8
📝 Monthly meetup for tech enthusiasts to share knowledge and network.
➕ Add to calendar

2. Photography Workshop
📅 01 Oct 2025 14:00
📍 Fabrika
📝 Learn street photography techniques with hands-on practice.
➕ Add to calendar
```

Telegram messages are sent in HTML parse mode, so both URLs hide behind tappable text rather than
being spelled out: the title opens the announcement, and `➕ Add to calendar` carries the
~250-character calendar URL.

Events are grouped into batches of `sendEventsBatchSize` (default: 5) per message. When there is more than one batch, each header is suffixed with `— Batch N/M`, and the batches are sent one second apart so a long digest does not arrive as a burst.

## Development

```bash
# Build TypeScript
npm run build

# Run compiled version
npm run start

# Development with hot reload
npm run dev
```

## Cost Optimization

- Uses gpt-6-luna, OpenAI's most cost-efficient tier, for optimal balance of speed, cost, and accuracy
- `reasoningEffort` (default: `low`) trades accuracy against cost and latency, globally or per step
- Intelligent seven-tier caching prevents redundant API calls; GPT results are keyed by model, that
  step's reasoning effort and its prompt text, so changing any of them re-runs only the affected step
- Confidence thresholds are applied when a cached result is read, never folded into the cache key, so
  retuning one re-judges what the model already said instead of paying for it again
- Configurable batch processing (defaults: event detection 16, classification 16, schedule filtering 16, description generation 3)
- Individual processing for interest matching to ensure accurate validation
- Preference-aware cache invalidation
- Incremental message fetching reduces Telegram API calls

## Debug Mode

Enable debug file output to troubleshoot interest matching or analyze GPT decisions:

```yaml
writeDebugFiles: true
```

Or via command line:
```bash
npm run dev -- --write-debug-files true
```

This creates six detailed JSON files in the `debug/` directory:
- `event_detection.json`: GPT filtering to identify single event announcements (step 3)
- `event_classification.json`: Event type detection (offline/online/hybrid) (step 4)
- `schedule_filtering.json`: Schedule filtering and datetime extraction (step 5)
- `location_filtering.json`: Venue/address extraction and location matching, with a discard-reason histogram (step 6)
- `interest_matching.json`: Interest matching decisions with GPT prompts/responses (step 7)
- `event_description.json`: Event description generation with extracted titles and summaries (step 9)

Each file includes:
- GPT prompts and responses
- Match/discard decisions
- Cache hit statistics
- Extraction success rates
- Invalid interest warnings (step 7)

## Contributing

This tool processes messages through multiple AI filtering steps. When modifying:

- Test interest matching with both positive and negative examples
- Ensure cache keys include relevant user preferences
- Validate date parsing with various GPT response formats
- Test authentication flow and session persistence
- Verify GPT response validation prevents hallucinated interests
- Follow Clean Architecture and DDD principles
- Keep domain logic separate from infrastructure concerns
- Co-locate constants with their usage (no separate constants files)

## License

MIT License - see [LICENSE](LICENSE) file for details.
