# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Build and Run:**
```bash
npm run build    # Compile TypeScript to dist/
npm run start    # Run compiled version
npm run dev      # Run with ts-node for development
```

**Example Usage:**

Option 1 - YAML Configuration (Recommended):
```bash
# Copy config.example.yaml to config.yaml and customize
cp config.example.yaml config.yaml
npm run dev
```

Option 2 - Custom YAML file:
```bash
npm run dev -- --config=my-config.yaml
```

Option 3 - Command line arguments:
```bash
npm run dev -- \
  --groups "group1,group2" \
  --channels "channel1,channel2" \
  --interests "Technology,Music,Photography" \
  --timeslots "6 14:00,0 14:00" \
  --location-filter "Tbilisi" \
  --max-group-messages 200 \
  --max-channel-messages 100 \
  --skip-online-events true \
  --write-debug-files true \
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

Option 4 - Override YAML config with CLI arguments:
```bash
# Use config.yaml but enable verbose logging for this run
npm run dev -- --verbose-logging true

# Mix YAML config with specific CLI overrides
npm run dev -- --event-detection-batch-size 8 --verbose-logging true
```

**Note:** Command-line arguments always override YAML configuration values.

## Architecture

This is an event digest CLI that processes Telegram messages through a 9-step filtering pipeline to extract relevant events. The codebase follows **Clean Architecture** and **Domain-Driven Design (DDD)** principles.

### Project Structure

```
src/
├── domain/                         # Business logic & domain entities
│   ├── entities/                   # Domain entities (DigestEvent, SourceMessage, etc.)
│   │   ├── digest-event.ts         # Core DigestEvent entity with optional fields
│   │   ├── source-message.ts       # Raw message data from any source
│   │   ├── interest-match.ts       # Interest match with confidence score
│   │   ├── event-type-classification.ts  # Event type classification with confidence
│   │   ├── event-location.ts       # Venue/address + matched location, with formatLocation()
│   │   ├── digest-event-description.ts  # Structured event information
│   │   ├── attendance-mode.ts      # AttendanceMode enum (OFFLINE/ONLINE/HYBRID)
│   │   └── index.ts                # Barrel export
│   ├── interfaces/                 # Domain interfaces (DDD abstraction layer)
│   │   ├── ai-client.interface.ts  # IAIClient interface for GPT operations
│   │   ├── cache.interface.ts      # ICache interface for caching operations
│   │   ├── message-source.interface.ts  # IMessageSource interface for Telegram
│   │   └── index.ts                # Barrel export
│   ├── services/                   # Business logic services (filtering, matching, etc.)
│   │   ├── event-cues-filter.ts    # Step 2: Text-based event filtering
│   │   ├── event-detector.ts       # Step 3: GPT event detection
│   │   ├── event-classifier.ts     # Step 4: Event type classification
│   │   ├── schedule-matcher.ts     # Step 5: Schedule extraction & matching (longest service)
│   │   ├── location-matcher.ts     # Step 6: Venue/address extraction and location filtering
│   │   ├── interest-matcher.ts     # Step 7: Interest matching with confidence (processes individually)
│   │   ├── event-deduplicator.ts   # Step 8: Collapse the same event from multiple sources (no GPT)
│   │   ├── event-describer.ts      # Step 9: Event description generation
│   │   └── index.ts                # Barrel export
│   └── constants.ts                # Domain constants (DATETIME_UNKNOWN)
├── application/                    # Use case orchestration
│   ├── event-pipeline.ts           # 9-step pipeline orchestrator
│   └── index.ts                    # Barrel export
├── data/                           # External systems (infrastructure layer)
│   ├── openai-client.ts            # OpenAI API client wrapper
│   ├── telegram-client.ts          # Telegram API client with session management
│   ├── cache.ts                    # Seven-tier caching system
│   └── index.ts                    # Barrel export
├── config/                         # Configuration management
│   ├── types.ts                    # Config interface definition
│   ├── defaults.ts                 # Default values & all GPT prompts
│   ├── constants.ts                # Config constants (GROUP_MESSAGE_MULTIPLIER)
│   ├── args-parser.ts              # CLI argument parsing & validation
│   ├── yaml-loader.ts              # YAML configuration file loading
│   ├── validator.ts                # Config validation & merging logic
│   └── index.ts                    # Barrel export with parseArgs function
├── shared/                         # Shared utilities & cross-cutting concerns
│   ├── date-utils.ts               # Date normalization (single source of truth)
│   ├── logger.ts                   # Logging utilities (verbose/normal)
│   ├── batch-processor.ts          # Batch processing & rate limiting
│   ├── readline-helper.ts          # Input prompts for Telegram auth
│   ├── debug-writer.ts             # Debug file writer (6 files)
│   ├── types/                      # Shared types
│   │   ├── debug-entries.ts        # Debug entry type definitions
│   │   └── index.ts                # Barrel export
│   └── index.ts                    # Barrel export
├── presentation/                   # Output formatting
│   ├── event-reporter.interface.ts # IEventReporter interface for output
│   ├── event-printer.ts            # Console event output formatting
│   ├── event-sender.ts             # Telegram message sending
│   ├── calendar-link.ts            # Google Calendar prefill URL, shared by both reporters
│   └── html-escape.ts              # Escaping for Telegram's HTML parse mode
└── index.ts                        # Application bootstrap
```

### Core Pipeline Flow

The pipeline is orchestrated by `application/event-pipeline.ts` which coordinates all domain services:

1. **Message Fetching** (`data/telegram-client.ts`) - Fetches messages from Telegram groups/channels using GramJS with incremental fetching via minId parameter
2. **Event Cue Filtering** (`domain/services/event-cues-filter.ts`) - Text-based filtering using configurable date/time keywords
3. **GPT Event Detection** (`domain/services/event-detector.ts`) - AI-powered filtering to identify single event announcements, returns DigestEvent[] with message field and event_detection_confidence (0.0-1.0 score)
4. **Event Type Classification** (`domain/services/event-classifier.ts`) - GPT classifies event type (offline/online/hybrid) and applies filtering based on skipOnlineEvents, adds event_type_classification field (EventTypeClassification with type and confidence) to DigestEvent
5. **Schedule Filtering** (`domain/services/schedule-matcher.ts`) - Extracts datetime with GPT, filters by user availability slots, adds start_datetime field to DigestEvent
6. **Location Filtering** (`domain/services/location-matcher.ts`) - Extracts the venue and address with GPT and, when `locationFilter` is set, decides which configured location the event falls in. The match has to be a model judgement: a post reading "Fabrika, Egnate Ninoshvili St 8" never names Tbilisi, so a string comparison would drop it. Runs after schedule filtering so only date-surviving events are paid for, and before interest matching and description so out-of-city events never reach the two costliest steps. Adds `event_location` to DigestEvent
7. **Interest Matching** (`domain/services/interest-matcher.ts`) - Matches events to user interests with confidence scoring and validation, adds interest_matches field to DigestEvent
8. **Deduplication** (`domain/services/event-deduplicator.ts`) - Collapses the same event announced by several sources into one entry. Makes no GPT calls, so it is neither cached nor rate-limited. Runs before description so duplicates never reach the costliest GPT step; the trade-off is that no normalised title exists yet, so events within a calendar day are compared by token overlap on source-message content alone. Posts of at least 20 distinct tokens are compared by containment (share of the *shorter* post's tokens found in the longer one, threshold 0.8) so that a trimmed or reworded repeat announcement still collapses; shorter posts fall back to Jaccard at the same threshold, where a length difference is evidence rather than noise. A post joins a cluster if it matches *any* member, not just the survivor. Keeps the earliest posting and records the rest — including sources those postings had themselves absorbed — in `duplicate_sources`. The printer spells them out on the event's `🔗` line; the sender links only the survivor, from the event title, and shows the rest not at all — they are copies of what the title already opens. When the earliest posting gave a date but no time and a later copy states one, the survivor adopts that time rather than reporting `(time unspecified)` for an hour the cluster knows. Controlled by `deduplicateEvents` (default: true)
9. **Event Description** (`domain/services/event-describer.ts`) - Generates structured event descriptions with GPT, adds event_description field (DigestEventDescription type) to DigestEvent

### Key Components

**Domain Entities** (`domain/entities/`):
- `SourceMessage`: Raw message data from any source (timestamp, content, link)
- `InterestMatch`: Interest matching result with confidence score (0.0-1.0)
- `EventTypeClassification`: Event type classification result with type (AttendanceMode) and confidence (0.0-1.0)
- `EventLocation`: Where an event is (venue, address), the configured location it matched, and a 0.0-1.0 confidence in that match. Exports `formatLocation()`, the single source of truth both reporters use to render the `📍` line
- `DigestEventDescription`: Structured event information (title, short_summary)
- `DigestEvent`: Single event type with optional fields populated through pipeline stages:
  - Step 3 adds: `message: SourceMessage` and `event_detection_confidence?: number` (0.0-1.0 confidence score)
  - Step 4 adds: `event_type_classification?: EventTypeClassification` (contains type: AttendanceMode enum and confidence: number)
  - Step 5 adds: `start_datetime?: Date`
  - Step 6 adds: `event_location?: EventLocation` (venue/address plus the matched configured location)
  - Step 7 adds: `interest_matches?: InterestMatch[]` (with confidence scores)
  - Step 8 adds: `duplicate_sources?: SourceMessage[]` (other postings of the same event)
  - Step 9 adds: `event_description?: DigestEventDescription`
- `AttendanceMode`: Enum defining how attendees can participate (OFFLINE = 'offline', ONLINE = 'online', HYBRID = 'hybrid')

**Domain Services** (`domain/services/`):
- `event-cues-filter.ts`: Text-based event filtering using keyword matching (Russian/English date keywords)
- `event-detector.ts`: GPT-powered event announcement detection with confidence scoring, uses aiClient.call()
- `event-classifier.ts`: Event type classification (offline/online/hybrid) with confidence-based filtering, uses aiClient.call()
- `schedule-matcher.ts`: Schedule extraction and availability matching (longest service), uses aiClient.call()
- `location-matcher.ts`: Venue/address extraction and location filtering (step 6), uses aiClient.call()
- `interest-matcher.ts`: Interest matching with confidence scoring and validation (processes individually for accuracy), uses aiClient.call()
- `event-deduplicator.ts`: Duplicate collapsing (step 8) — pure text comparison, no aiClient
- `event-describer.ts`: Event description generation, uses aiClient.call()

The six GPT services resolve their reasoning effort via `getStepReasoningEffort(config, step)` (`config/validator.ts`) and pass it as `aiClient.call(prompt, { reasoningEffort })`.

**Application Layer** (`application/`):
- `event-pipeline.ts`: Orchestrates entire 9-step pipeline with dependency injection (IAIClient, ICache, IMessageSource, DebugWriter), coordinates all domain services, manages debug file writing, provides step-by-step progress logging (e.g., "Step 3/9: Detecting event announcements...")

**Data Layer** (`data/`):
- `openai-client.ts`: OpenAI API wrapper implementing IAIClient interface, rate limiting (1-second delays), uses the **gpt-6-luna** model (exported as `GPT_MODEL` so cache keys can be scoped to it). Passes no `temperature` — gpt-6-luna is a reasoning model and rejects it. `reasoning_effort` comes from the caller, defaulting to `'low'`. Includes retry logic with exponential backoff for rate limit errors (max 3 retries: 2s, 4s, 8s delays)
- `telegram-client.ts`: Telegram API client implementing IMessageSource interface (fetchMessages and sendMessage methods), session management, uses readline-helper for authentication prompts
- `cache.ts`: Seven-tier caching system implementing ICache interface, messages and GPT results with preference-aware keys. Takes a `CacheVariant` (model + per-step reasoning effort and prompt) at construction and folds it into every GPT cache key, so changing the model, a step's effort or its prompt re-runs that step instead of serving stale results
- `entity-cache.ts`: Resolved Telegram channel entities (`.cache/resolved_entities.json`), kept separate from the seven GPT/message stores. Exists to avoid repeated ResolveUsername calls and the flood-wait bans they trigger — **do not delete this file when clearing caches**

**Configuration** (`config/`):
- Supports YAML configuration files (config.yaml/config.yml) or command-line arguments
- Command-line arguments override YAML configuration values
- `types.ts`: Complete Config interface definition
- `defaults.ts`: All default values including event cues and all 6 GPT prompts (single source of truth)
- `args-parser.ts`: Command-line argument parsing with VALID_OPTIONS validation
- `yaml-loader.ts`: YAML file loading with error handling
- `validator.ts`: Merges user config with defaults, validates required fields
- Detailed validation for groups, channels, interests, timeslots, and message limits
- `skipOnlineEvents` parameter (default: true) excludes online-only events
- `includeEventsWithoutTime` parameter (default: true) keeps events whose date is known but whose time is not. The step 5 prompt explicitly asks for `"27 Sep 2026 unknown"` when a post names the day but not the hour; without that instruction the model answered a bare `"unknown"` and the event was dropped. Measured on 48 messages step 5 had discarded as "no date/time found", the instruction recovers a date for 47 of them, and on 48 messages that already yielded a full datetime it costs the time on 1 (a course listing several weekly slots). Such events cannot be checked against `weeklyTimeslots`, so they bypass that filter and are rendered as `"27 Sep 2026 (time unspecified)"`. A custom `scheduleExtractionPrompt` that omits the instruction leaves this option with nothing to keep. The option is **not** part of the step 5 cache key: the store holds `{ datetime, timeKnown }` as parsed from the model's answer and the option is applied on read, so toggling it costs no GPT calls
- `deduplicateEvents` parameter (default: true) collapses duplicate events (step 8)
- `maxInputMessages`/`--max-messages` is a legacy single limit kept for backward compatibility. It is consulted only when *neither* `maxGroupMessages` nor `maxChannelMessages` is given, and is the reason the group default reads as 800 in that case — `validator.ts` multiplies it by `GROUP_MESSAGE_MULTIPLIER`
- `locationFilter` parameter (default: `[]`) limits the digest to events in the listed places, e.g. `["Tbilisi"]`. Empty means no filtering — step 6 still runs, so venue and address are extracted for display either way. The list is an *input to the prompt* (the model returns an index into it), so it is folded into the `event_locations` cache key the same way `userInterests` is folded into `matching_interests`
- `includeEventsWithoutLocation` parameter (default: true) keeps events whose announcement named no place at all. Turning it off also drops every online event, since a virtual event has no venue to match. Applied on *read*, so toggling it re-judges cached results with no GPT calls
- `writeDebugFiles` parameter (default: false) enables debug file output to debug/ directory
- `verboseLogging` parameter (default: false) enables detailed processing logs with cache stats, batch numbers, and DISCARDED message links
- **Configurable confidence thresholds** (all optional with defaults optimized for quality filtering):
  - `minEventDetectionConfidence` (default: 0.7): Minimum confidence (0.0-1.0) for step 3 event detection; higher values = fewer but more certain events
  - `minEventClassificationConfidence` (default: 0.7): Minimum confidence (0.0-1.0) for step 4 event type classification; higher values = stricter classification. Applied on read, so retuning it costs no GPT calls
  - `minLocationConfidence` (default: 0.7): Minimum confidence (0.0-1.0) for step 6 location matching; applied on read, so retuning it costs no GPT calls
  - `minInterestConfidence` (default: 0.75): Minimum confidence (0.0-1.0) for step 7 interest matching; GPT assigns scores, only matches ≥ threshold are included
- **Configurable GPT batch sizes** (all optional with defaults optimized for balance of speed and accuracy):
  - `eventDetectionBatchSize` (default: 16): Controls batch size for step 3 event detection
  - `eventClassificationBatchSize` (default: 16): Controls batch size for step 4 event type classification
  - `scheduleExtractionBatchSize` (default: 16): Controls batch size for step 5 schedule extraction
  - `locationExtractionBatchSize` (default: 16): Controls batch size for step 6 location extraction
  - `eventDescriptionBatchSize` (default: 3): Controls batch size for step 9 event description generation
- **Configurable reasoning effort** (trades accuracy against cost and latency):
  - `reasoningEffort` (default: `low`): Effort for every GPT step; one of `none`, `low`, `medium`, `high`, `xhigh` (values defined by `REASONING_EFFORTS` in `domain/interfaces/ai-client.interface.ts`; `max` is excluded because openai@6's type union omits it)
  - Per-step overrides, each falling back to `reasoningEffort`: `eventDetectionReasoningEffort`, `eventClassificationReasoningEffort`, `scheduleExtractionReasoningEffort`, `locationExtractionReasoningEffort`, `interestMatchingReasoningEffort`, `eventDescriptionReasoningEffort`
  - Resolved through `getStepReasoningEffort(config, step)` in `config/validator.ts` — the single source of truth used by both the AI calls and the cache keys
  - Reasoning tokens share the completion-token budget, so raising effort on step 9 (one output block per input message) risks truncating the response
- **Configurable GPT prompts** (all optional with sensible defaults in config/defaults.ts):
  - `eventDetectionPrompt`: Customizes event detection logic (step 3) - uses `{{MESSAGES}}` placeholder
  - `eventTypeClassificationPrompt`: Customizes event type classification (step 4) - uses `{{MESSAGES}}` placeholder
  - `scheduleExtractionPrompt`: Customizes datetime extraction (step 5) - uses `{{TODAY_DATE}}` and `{{MESSAGES}}` placeholders
  - `locationExtractionPrompt`: Customizes venue extraction and location matching (step 6) - uses `{{LOCATIONS}}` and `{{MESSAGES}}` placeholders. Responses are pipe-separated (`NUMBER|VENUE|ADDRESS|INDEX|CONFIDENCE`) rather than colon-separated, because venue names and addresses contain colons
  - `interestMatchingPrompt`: Customizes interest matching logic (step 7) - uses `{{EVENTS}}` and `{{INTERESTS}}` placeholders
  - `eventDescriptionPrompt`: Customizes event description generation (step 9) - uses `{{EVENTS}}` placeholder
  - See config.example.yaml for placeholder documentation and example prompts
- **Event Delivery** (optional):
  - `sendEventsRecipient` (no default): Telegram recipient for event delivery (e.g., @username or chat ID); when configured, events are sent to this recipient instead of being printed to console. When undefined (default), events are printed to console.
  - `sendEventsBatchSize` (default: 5): Number of events to send per Telegram message batch. Consecutive batches are spaced by `RATE_LIMIT_DELAY`, since a burst of messages is what Telegram rate-limits on

**Shared Layer** (`shared/`):
- `date-utils.ts`: Single source of truth for date normalization, handles GPT's inconsistent formats, exports DATE_FORMAT and MAX_FUTURE_YEARS constants
- `logger.ts`: Logging utilities with verbose mode support (fixed parameter name from `verbose` to `isVerbose`), uses "✗ Discarded:" prefix for filtered messages in verbose mode
- `batch-processor.ts`: Generic batch processing utilities, exports RATE_LIMIT_DELAY constant
- `readline-helper.ts`: Extracts duplicated readline logic from telegram-client, handles password/code prompts (fixed type issues with MutableReadline interface)
- `debug-writer.ts`: Concrete implementation for debug file writing, writes 6 debug files (event_detection.json, event_classification.json, schedule_filtering.json, location_filtering.json, interest_matching.json, event_description.json). Like Logger, this is a concrete class used directly (not abstracted behind an interface)
- `types/debug-entries.ts`: Debug entry type definitions using primitive types (DebugEventDetectionEntry, DebugTypeClassificationEntry, DebugScheduleFilteringEntry, DebugLocationFilteringEntry, DebugInterestMatchingEntry, DebugEventDescriptionEntry) - uses primitives instead of domain entities to maintain clean architecture boundaries

**Presentation Layer** (`presentation/`):
- `event-reporter.interface.ts`: IEventReporter interface defining report() method for event output
- `event-printer.ts`: Console output formatting with emoji icons, sorts events by datetime, implements IEventReporter
- `event-sender.ts`: Telegram message sending with batch support, formats events as structured Telegram messages, implements IEventReporter. Consecutive batches are spaced by `RATE_LIMIT_DELAY`. Sends **HTML**, so both URLs hide behind tappable text — the event title opens the announcement and an `Add to calendar` label carries the calendar URL — which means every interpolated field has to go through `escapeHtml`. There is no `🔗` line (the title replaced it), but the `🏷️` line is present, between `📍` and `📝` exactly as the printer orders it, so both reporters render an event the same way. It was omitted once on the reasoning that the matched interests are the reader's own `userInterests` read back to them; in practice they are what tells you *why* an event surfaced, which is worth a line in the digest you actually read. Interests are free text, so they go through `escapeHtml` like every other field
- `calendar-link.ts` builds its query with `encodeURIComponent` rather than `URLSearchParams`, and this must not be "simplified" back. `URLSearchParams` encodes a space as `+`, and GramJS screens every link in an outgoing message against `/^@|\+|tg:\/\/user\?id=(\d+)/` to find mentions; the `\+` alternative is unanchored, so a single `+` anywhere in the URL makes it take the whole thing for a username, fail to resolve it, and **delete the link entity**. The symptom is the tell: the label renders cleanly and simply does nothing when tapped, while the short `t.me` links beside it keep working because they contain no `+`
- `html-escape.ts`: `escapeHtml` for Telegram's HTML parse mode. HTML rather than Markdown because only `&`, `<` and `>` carry meaning there, and `&` alone is common in real titles and venue names ("D&D Open Tables", "Grape Wine & Kitchen"); an unescaped one makes Telegram reject the whole batch, and Markdown would need a larger dialect-dependent escape set for the same job
- `calendar-link.ts`: Builds the `➕` Google Calendar prefill URL both reporters render. Lives in presentation, not domain, because it is pure rendering — unlike `formatLocation`, nothing downstream reads it. Uses Google's `render?action=TEMPLATE` endpoint, which needs no key or OAuth. Two judgements are baked in: an event's end is never stated in an announcement, so `ASSUMED_EVENT_DURATION_HOURS` (2) fills the range the endpoint requires; and a time-less event becomes an *all-day* entry rather than a block at the noon `parseEventDateTime` parked it at, since the day is all the post actually claimed. `dates` is appended outside `URLSearchParams` so its `/` separator stays literal

**Authentication** (`data/telegram-client.ts`):
- Uses persistent session storage in `.telegram-session` file
- First run requires phone verification via readline prompts, subsequent runs are automatic
- Session saved only after successful login

**Caching System** (`data/cache.ts`):
- Comprehensive caching with descriptive cache store names
- Seven separate cache stores:
  - `telegram_messages`: Raw Telegram messages per source (step 1) - assumes message immutability
  - `messages`: Event detection results (step 3) - stores `{ isEvent, confidence }`, the model's verdict and score *before* any threshold
  - `event_type_classification`: Event type classification results (step 4) - stores `{ type, confidence }` as the model returned it; `minEventClassificationConfidence` is applied on read
  - `scheduled_events`: Schedule filtering and datetime extraction (step 5)
  - `event_locations`: Venue/address extraction and location match (step 6) - stores `EventLocation | null` as the model returned it; `minLocationConfidence` and `includeEventsWithoutLocation` are applied on read
  - `matching_interests`: Interest matching results (step 7)
  - `events`: Final event object conversion (step 9)
- Message caching strategy: Fetches only new messages since last cached timestamp using minId parameter, combines with cached messages
- Cache keys use message links + hashed preferences for efficient storage
- Hash-based keys prevent cache bloat while maintaining preference isolation

### Important Implementation Details

**Interest Matching:** Uses comprehensive GPT guidelines with mandatory matching rules for specific patterns (e.g., "айти нытьё" → IT networking, karaoke → social events). **Confidence scoring** ensures only high-quality matches: GPT assigns 0.0-1.0 confidence scores to each interest match, with only matches ≥ `minInterestConfidence` (default: 0.75) included in results. This reduces over-matching from ~8% to <3%. **Validation layer** (implemented in `domain/services/interest-matcher.ts`) ensures GPT-returned interest indices are validated against the actual user interest list (filters invalid indices and warns about them), preventing hallucinated categories like "Cultural interests" or "EdTech" from polluting results. Events are processed individually (not batched) to ensure accurate validation.

**Date Handling:** Single source of truth in `normalizeDateTime()` function (`shared/date-utils.ts`) handles GPT's inconsistent date format responses. Normalizes both "dd MMM yyyy HH" and "dd MMM yyyy HH:mm" formats.

**GPT Response Parsing:** Robust parsing handles both structured responses and prose responses like "No messages match any interests."

**Rate Limiting:** 1-second delays between GPT calls via `delay()` function in `shared/batch-processor.ts`. Batch processing with configurable batch sizes (defaults: event detection 16, event type classification 16, schedule filtering 16, event description 3). Interest matching processes events individually for accurate validation.

**Two-Stage GPT Processing:**
1. Basic event detection (`domain/services/event-detector.ts`) - Identifies genuine event announcements
2. Event type classification (`domain/services/event-classifier.ts`) - Classifies as offline/online/hybrid and applies filtering

**Event Type Detection:** GPT classifies each event as offline (in-person), online (virtual), or hybrid, stored in DigestEvent.event_type_classification field (EventTypeClassification contains both type and confidence score). Classification uses explicit indicators:
- **Offline**: Physical addresses, venue names, city names, Google/Yandex Maps links, office locations
- **Online**: Zoom/Google Meet links, explicit "online" mentions, webinar URLs
- **Hybrid**: Events offering both physical and online participation options

**Online Events Filter:** When `skipOnlineEvents` is enabled (default), only events with physical attendance options are included:
- ✅ **offline events** (in-person only) - always included
- ✅ **hybrid events** (both in-person and online options) - included because they offer physical attendance
- ❌ **online events** (virtual only) - excluded

This filtering happens during the type classification stage in `domain/services/event-classifier.ts`.

## Environment Setup

Required environment variables (see `.env.example`):
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER` - Telegram API credentials
- `OPENAI_API_KEY` - OpenAI API key for the gpt-6-luna model

Optional, used only by the source-discovery scripts (the digest itself runs without it):
- `TELEGRAM_ARCHIVE_DB` - path to the local Telegram archive that `discover-sources.ts discover` mines. **No default**, deliberately: an export lives wherever its owner put it, usually outside the repo, so a default would be one machine's directory layout committed to a shared file. Create an archive with `scripts/export-telegram.ts` (see below) or point at an existing export. Both `discover-sources.ts` and `expand-sources.ts` call `dotenv.config()`, so `.env` is enough — no need to export it in the shell

**Environment Variable Validation:** The application validates all required environment variables at startup before initializing clients. Missing variables will cause immediate failure with a clear error message referencing `.env.example`.

The `.telegram-session` file is automatically created and managed for persistent authentication.

## Cache Management

Cache is stored in `.cache/` directory with separate files per cache store:
- `.cache/telegram_messages.json`: Raw Telegram messages per source (step 1, assumes immutability)
- `.cache/messages.json`: Event detection results (step 3, no preferences needed) - stores `{ isEvent, confidence }` as the model returned them. `minEventDetectionConfidence` is applied on *read*, so retuning the threshold re-judges already-seen messages with no GPT calls and no cache invalidation. Entries written before the score was stored are bare booleans and are read as a verdict with no confidence, so a legacy discard cannot be re-judged against a lowered threshold
- `.cache/event_type_classification.json`: Event type classification results (step 4, no preferences needed) - stores `{ type, confidence }` as the model returned it. `minEventClassificationConfidence` is applied on *read*, so retuning the threshold re-judges already-classified events with no GPT calls. An event the model returned no line for is stored as offline with a deliberately low stand-in confidence (`FALLBACK_CLASSIFICATION_CONFIDENCE`), which the default threshold rejects — an unanswered event is not a confident one
- `.cache/scheduled_events.json`: Schedule filtering results (step 5, no preferences in cache key)
- `.cache/event_locations.json`: Location extraction and matching results (step 6, includes locations hash)
- `.cache/matching_interests.json`: Interest matching results (step 7, includes interests hash)
- `.cache/events.json`: Final event objects (step 9, includes interests hash)
- `.cache/resolved_entities.json`: Resolved Telegram channel entities, owned by `data/entity-cache.ts` (not part of the `Cache` class)
- `.cache/source_yield_history.json`: Per-source yield observations, owned by `scripts/discover-sources.ts prune`. Not a cache but state — it is the accumulated evidence that a source is dead, and deleting it resets every source's history to nothing, which is indistinguishable from every source being healthy

**Clearing the cache:** delete only the six GPT stores (`messages`, `event_type_classification`, `scheduled_events`, `event_locations`, `matching_interests`, `events`). Keep `telegram_messages.json` — re-fetching all sources is slow and risks Telegram FLOOD_WAIT. Keep `resolved_entities.json` — deleting it re-resolves every channel and triggers the ResolveUsername flood it was added to prevent. Keep `source_yield_history.json` — it is prune evidence, not a cache.

**Caching model output vs. policy:** a store should hold what the model returned, not what the configuration then decided. Step 3 keeps the raw confidence and applies `minEventDetectionConfidence` on read; step 4 likewise keeps the `{ type, confidence }` verdict and applies `minEventClassificationConfidence` on read; step 5 keeps `{ datetime, timeKnown }` as parsed from the answer and applies `includeEventsWithoutTime` on read; step 6 keeps the extracted `EventLocation` and applies both `minLocationConfidence` and `includeEventsWithoutLocation` on read. Caching the *decision* instead has a second cost beyond the wasted GPT calls, which is how it was found in step 4: a rejected verdict was never stored, so every run re-asked and the model's answer drifted across the threshold, making the step's output depend on whether it had run before. None of those options belongs in a cache key — a setting that only filters model output must never force GPT calls to be repeated. `locationFilter` is the exception that proves the rule: the model is shown the list and returns an index into it, so it is a genuine prompt input and belongs in the key, exactly as `userInterests` does for steps 7 and 9. `createListScopedKey` in `data/cache.ts` is the shared helper for both.

**AI-variant cache keys:** every GPT store's key includes a hash of the model (`GPT_MODEL`), that step's effective reasoning effort, and that step's prompt text. Changing any of them re-runs only the affected step, and different configurations coexist in the same file — which is what makes reasoning-effort A/B runs cheap to repeat.

**Message Caching Strategy:**
- Messages are assumed to be immutable once published
- Uses `minId` parameter to fetch only messages with ID greater than the last cached message ID
- Extracts last message ID from cache, passes as minId to Telegram API
- Combines cached and newly fetched messages, removing duplicates by message link
- Significantly reduces Telegram API calls on subsequent runs

**Cache Type Safety:**
- All cache getter methods return `T | undefined` (not `null`) for missing values
- `undefined` consistently represents "not found in cache"
- Cache operations throw errors on save failures rather than silently failing

Cache keys include relevant user preferences to ensure correct invalidation when settings change. Each cache store is maintained in its own file for better organization and independent management.

## Debug Files

When `writeDebugFiles` is enabled (default: false), the tool writes detailed debug information to the `debug/` directory:
- `event_detection.json`: GPT filtering to identify single event announcements (step 3)
- `event_classification.json`: GPT classification of events as hybrid/offline/online with prompts and responses (step 4)
- `schedule_filtering.json`: Schedule filtering and datetime extraction results (step 5)
- `location_filtering.json`: Venue/address extraction and location matching, with a `discard_reasons` histogram (step 6)
- `interest_matching.json`: Interest matching results showing which events matched which interests (step 7)
- `event_description.json`: Event description generation with extracted titles and summaries (step 9)

Debug files include GPT prompts, responses, cache status, and detailed statistics. Use for troubleshooting event detection, interest matching accuracy, or understanding GPT's decision-making process.

**Every input gets an entry.** A step's debug file has to account for each event it was handed, kept or dropped, so that `total_entries` reconciles with the count the step logged and `discard_reasons` is a complete census of where the rest went. The discard branches are the easy ones to forget, because the cache write happens regardless: a missing entry costs no GPT calls and shows up only as an event that vanished without explanation. Step 5's `recordNoDateFound` exists for that reason — it is shared by the four paths that can fail to date an event (cached null, an `unknown` answer, a line the model omitted, and an empty reply), all of which previously returned bare from at least one of them.

## Architecture Principles

The codebase follows **Clean Architecture** and **DDD** principles:

1. **Separation of Concerns**: Business logic (domain), use cases (application), external systems (data), configuration, and presentation are clearly separated
2. **Single Responsibility**: Each module has one clear purpose
3. **Dependency Injection**: Domain services accept interfaces as parameters, application layer uses constructor injection, bootstrap layer instantiates concrete implementations
4. **Dependency Inversion**: Domain defines interfaces (`IAIClient`, `ICache`, `IMessageSource`), outer layers implement them
5. **No Code Duplication**: Shared logic extracted to utilities and services
6. **Constants Management**: Configuration constants are centralized in `config/constants.ts` with documented rationale. Operation-specific constants (like `GPT_MODEL`, `RATE_LIMIT_DELAY`, `DATE_FORMAT`) stay co-located with their usage context for better maintainability
7. **YAGNI Principle**: No DI containers (simple constructor injection suffices), Config type not abstracted (stable, unlikely to change)

**Note on Architecture:** This codebase follows Clean Architecture principles with dependency injection for all infrastructure concerns. Domain services accept interfaces (`IAIClient`, `ICache`) as parameters, the application layer (`EventPipeline`) receives interface instances via constructor injection, and the bootstrap layer (`index.ts`) instantiates concrete implementations. The only pragmatic deviation is that domain services directly import the `Config` type from outer layers rather than abstracting it behind an interface, as configuration is stable and unlikely to change implementation.

## Key File Locations

When working with specific functionality, refer to these files:

- **Add/modify event detection logic**: `domain/services/event-detector.ts`
- **Change event type classification**: `domain/services/event-classifier.ts`
- **Modify schedule matching**: `domain/services/schedule-matcher.ts`
- **Update interest matching**: `domain/services/interest-matcher.ts`
- **Change event description generation**: `domain/services/event-describer.ts`
- **Add new configuration options**: Start with `config/types.ts`, then `config/defaults.ts`, then `config/validator.ts`, then `config/args-parser.ts`
- **Modify GPT prompts**: `config/defaults.ts` (single source of truth)
- **Add new entity fields**: Relevant file in `domain/entities/`
- **Add new domain interfaces**: `domain/interfaces/` (IAIClient, ICache, IMessageSource)
- **Change caching logic**: `data/cache.ts` (implements ICache)
- **Modify Telegram fetching**: `data/telegram-client.ts` (implements IMessageSource)
- **Update OpenAI integration**: `data/openai-client.ts` (implements IAIClient)
- **Change pipeline orchestration**: `application/event-pipeline.ts` (uses all domain interfaces)
- **Add new presentation interfaces**: `presentation/event-reporter.interface.ts` (IEventReporter)
- **Modify output formatting**: `presentation/event-printer.ts` (implements IEventReporter)
- **Modify event sending logic**: `presentation/event-sender.ts` (implements IEventReporter)
- **Change the calendar link or its assumed duration**: `presentation/calendar-link.ts`
- **Tune duplicate detection**: `domain/services/event-deduplicator.ts` (the similarity threshold is a constant at the top)
- **Change location extraction or filtering**: `domain/services/location-matcher.ts`
- **Discover new sources**: `scripts/discover-sources.ts` (offline archive mining; also `add` and `prune`, the only commands that write `config.yaml`) and `scripts/expand-sources.ts` (live Telegram discovery APIs; `verify` is the gate `add` consumes). The end-to-end runbook is the `source-discovery` skill in `.claude/skills/`
- **Create the archive discovery mines**: `scripts/export-telegram.ts` — step 0, and the reason discovery is usable on a fresh checkout at all. Writes a SQLite archive of your own dialogs holding **only the seven columns `discover` reads**; everything else Telegram returns is dropped rather than kept, since an unread copy of private messages on disk is a liability with no upside. Chat `type` uses Telegram Desktop's JSON-export vocabulary (`personal_chat`, `private_group`, `private_supergroup`, `channel`, `saved_messages`) and `forwarded_from_id` keeps its `channel<id>`/`user<id>` shape, because `discover` keys `NOT_ADDABLE_TYPES` on the former and filters the forward graph with `LIKE 'channel%'` on the latter — an archive from Telegram's own exporter has to stay readable by the same queries. Three judgements worth knowing: private chats are **excluded by default** (`--include-personal` opts in) because they are the bulk of a dialog list and the most sensitive part of it, and `discover` cannot act on them anyway — `personal_chat` is in `NOT_ADDABLE_TYPES`, so the best it can say is "follow the channel behind this instead"; the export is **incremental and resumable** via a `max_message_id` per chat in an `export_state` table, mirroring the digest's `minId` strategy, which matters because a full sweep is thousands of MTProto calls and *will* meet the budget or a `FLOOD_WAIT` partway; and it **refuses to write into a database it did not create** (detected by the absence of `export_state`), because appending to a richer pre-existing schema would find `CREATE TABLE IF NOT EXISTS` a no-op, then duplicate rows on every rerun since such a table has no `UNIQUE (chat_id, message_id)`. For the same reason `--out` does *not* default to `TELEGRAM_ARCHIVE_DB`: that variable names the archive discovery **reads**, and pointing a writer at it by default aims the script at a file it must not touch
- **Add or remove a source**: never hand-edit `config.yaml` for this. Run `expand-sources.ts verify` then `discover-sources.ts add`: the channel-vs-group bucket and duplicate-under-another-label are both unknowable offline. `fetchMessagesFromSource` type-checks only the display-name branch, so a *display-name* entry in the wrong list silently fetches nothing forever, with no symptom in the logs, while an `@handle` entry in the wrong list still fetches but with the wrong message limit (200 vs 50) and the wrong cache-key prefix. A config entry is a handle *or* a display name, and only the resolved `username`/`c/<id>` identity — what the message cache is keyed on — makes two entries comparable
- **Change debug file output**: `shared/debug-writer.ts`
- **Add environment variable validation**: `src/index.ts` (validateEnvironmentVariables function)

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
