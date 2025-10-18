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
  --max-group-messages 200 \
  --max-channel-messages 100 \
  --skip-online-events true \
  --write-debug-files true \
  --verbose-logging false \
  --min-interest-confidence 0.75 \
  --event-detection-batch-size 16 \
  --event-classification-batch-size 16 \
  --schedule-extraction-batch-size 16 \
  --event-description-batch-size 5
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

This is an event digest CLI that processes Telegram messages through a 7-step filtering pipeline to extract relevant events. The codebase follows **Clean Architecture** and **Domain-Driven Design (DDD)** principles.

### Project Structure

```
src/
├── domain/                         # Business logic & domain entities
│   ├── entities/                   # Domain entities (Event, SourceMessage, etc.)
│   │   ├── event.ts                # Core Event entity with optional fields
│   │   ├── source-message.ts       # Raw message data from any source
│   │   ├── interest-match.ts       # Interest match with confidence score
│   │   ├── event-description.ts    # Structured event information
│   │   ├── event-type.ts           # EventType enum (OFFLINE/ONLINE/HYBRID)
│   │   └── index.ts                # Barrel export
│   ├── interfaces/                 # Domain interfaces (DDD abstraction layer)
│   │   ├── ai-client.interface.ts  # IAIClient interface for GPT operations
│   │   ├── cache.interface.ts      # ICache interface for caching operations
│   │   ├── message-source.interface.ts  # IMessageSource interface for Telegram
│   │   ├── debug-writer.interface.ts    # IDebugWriter interface for debug output
│   │   └── index.ts                # Barrel export
│   ├── services/                   # Business logic services (filtering, matching, etc.)
│   │   ├── event-cues-filter.ts    # Step 2: Text-based event filtering
│   │   ├── event-detector.ts       # Step 3: GPT event detection (~174 lines)
│   │   ├── event-classifier.ts     # Step 4: Event type classification
│   │   ├── schedule-matcher.ts     # Step 5: Schedule extraction & matching (~368 lines, longest service)
│   │   ├── interest-matcher.ts     # Step 6: Interest matching with confidence (~232 lines, processes individually)
│   │   ├── event-describer.ts      # Step 7: Event description generation
│   │   └── index.ts                # Barrel export
│   ├── types/                      # Domain types (debug entries, etc.)
│   │   └── index.ts                # Debug entry type definitions
│   └── constants.ts                # Domain constants (DATETIME_UNKNOWN)
├── application/                    # Use case orchestration
│   ├── event-pipeline.ts           # 7-step pipeline orchestrator
│   └── index.ts                    # Barrel export
├── data/                           # External systems (infrastructure layer)
│   ├── openai-client.ts            # OpenAI API client wrapper
│   ├── telegram-client.ts          # Telegram API client with session management
│   ├── cache.ts                    # Six-tier caching system
│   └── index.ts                    # Barrel export
├── config/                         # Configuration management
│   ├── types.ts                    # Config interface definition
│   ├── defaults.ts                 # Default values & all GPT prompts
│   ├── constants.ts                # Config constants (GROUP_MESSAGE_MULTIPLIER)
│   ├── args-parser.ts              # CLI argument parsing & validation
│   ├── yaml-loader.ts              # YAML configuration file loading
│   ├── validator.ts                # Config validation & merging logic
│   └── index.ts                    # Barrel export with parseArgs function
├── shared/                         # Shared utilities
│   ├── date-utils.ts               # Date normalization (single source of truth)
│   ├── logger.ts                   # Logging utilities (verbose/normal)
│   ├── batch-processor.ts          # Batch processing & rate limiting
│   └── readline-helper.ts          # Input prompts for Telegram auth
├── presentation/                   # Output formatting
│   ├── event-printer.ts            # Console event output formatting
│   └── debug-writer.ts             # Debug file writer (5 files)
└── index.ts                        # Application bootstrap
```

### Core Pipeline Flow

The pipeline is orchestrated by `application/event-pipeline.ts` which coordinates all domain services:

1. **Message Fetching** (`data/telegram-client.ts`) - Fetches messages from Telegram groups/channels using GramJS with incremental fetching via minId parameter
2. **Event Cue Filtering** (`domain/services/event-cues-filter.ts`) - Text-based filtering using configurable date/time keywords
3. **GPT Event Detection** (`domain/services/event-detector.ts`) - AI-powered filtering to identify single event announcements, returns Event[] with message field
4. **Event Type Classification** (`domain/services/event-classifier.ts`) - GPT classifies event type (offline/online/hybrid) and applies filtering based on skipOnlineEvents, adds event_type field to Event
5. **Schedule Filtering** (`domain/services/schedule-matcher.ts`) - Extracts datetime with GPT, filters by user availability slots, adds start_datetime field to Event
6. **Interest Matching** (`domain/services/interest-matcher.ts`) - Matches events to user interests with confidence scoring and validation, adds interests_matched and interest_matches fields to Event
7. **Event Description** (`domain/services/event-describer.ts`) - Generates structured event descriptions with GPT, adds event_description field to Event

### Key Components

**Domain Entities** (`domain/entities/`):
- `SourceMessage`: Raw message data from any source (timestamp, content, link)
- `InterestMatch`: Interest matching result with confidence score (0.0-1.0)
- `EventDescription`: Structured event information (date_time, met_interests, title, short_summary, link)
- `Event`: Single event type with optional fields populated through pipeline stages:
  - Step 3 adds: `message: SourceMessage`
  - Step 4 adds: `event_type?: EventType` (enum: OFFLINE, ONLINE, HYBRID)
  - Step 5 adds: `start_datetime?: string`
  - Step 6 adds: `interests_matched?: string[]` and `interest_matches?: InterestMatch[]` (with confidence scores)
  - Step 7 adds: `event_description?: EventDescription`
- `EventType`: Enum defining event types (OFFLINE = 'offline', ONLINE = 'online', HYBRID = 'hybrid')

**Domain Services** (`domain/services/`):
- `event-cues-filter.ts`: Text-based event filtering using keyword matching (Russian/English date keywords)
- `event-detector.ts`: GPT-powered event announcement detection (~180 lines)
- `event-classifier.ts`: Event type classification (offline/online/hybrid) with online event filtering
- `schedule-matcher.ts`: Schedule extraction and availability matching (~370 lines, longest service)
- `interest-matcher.ts`: Interest matching with confidence scoring and validation (~235 lines, processes individually for accuracy)
- `event-describer.ts`: Event description generation with creative temperature

**Application Layer** (`application/`):
- `event-pipeline.ts`: Orchestrates entire 7-step pipeline with dependency injection (IAIClient, ICache, IMessageSource, IDebugWriter), coordinates all domain services, manages debug file writing, provides step-by-step progress logging (e.g., "Step 3/7: Detecting event announcements...")

**Data Layer** (`data/`):
- `openai-client.ts`: OpenAI GPT API wrapper implementing IAIClient interface, rate limiting (1-second delays), uses GPT-5-mini model with temperature 1.0 for all operations (both standard and creative), exposes GPT_TEMPERATURE_CREATIVE constant (also 1.0)
- `telegram-client.ts`: Telegram API client implementing IMessageSource interface, session management, uses readline-helper for authentication prompts
- `cache.ts`: Six-tier caching system implementing ICache interface, messages and GPT results with preference-aware keys

**Configuration** (`config/`):
- Supports YAML configuration files (config.yaml/config.yml) or command-line arguments
- Command-line arguments override YAML configuration values
- `types.ts`: Complete Config interface definition
- `defaults.ts`: All default values including event cues and all 5 GPT prompts (single source of truth)
- `args-parser.ts`: Command-line argument parsing with VALID_OPTIONS validation
- `yaml-loader.ts`: YAML file loading with error handling
- `validator.ts`: Merges user config with defaults, validates required fields
- Detailed validation for groups, channels, interests, timeslots, and message limits
- `skipOnlineEvents` parameter (default: true) excludes online-only events
- `writeDebugFiles` parameter (default: false) enables debug file output to debug/ directory
- `verboseLogging` parameter (default: false) enables detailed processing logs with cache stats, batch numbers, and DISCARDED message links
- `minInterestConfidence` parameter (default: 0.75) sets minimum confidence threshold for interest matching; GPT assigns 0.0-1.0 scores, only matches ≥ threshold are included
- **Configurable GPT batch sizes** (all optional with defaults optimized for balance of speed and accuracy):
  - `eventDetectionBatchSize` (default: 16): Controls batch size for step 3 event detection
  - `eventClassificationBatchSize` (default: 16): Controls batch size for step 4 event type classification
  - `scheduleExtractionBatchSize` (default: 16): Controls batch size for step 5 schedule extraction
  - `eventDescriptionBatchSize` (default: 5): Controls batch size for step 7 event description generation
- **Configurable GPT prompts** (all optional with sensible defaults in config/defaults.ts):
  - `eventDetectionPrompt`: Customizes event detection logic (step 3) - uses `{{MESSAGES}}` placeholder
  - `eventTypeClassificationPrompt`: Customizes event type classification (step 4) - uses `{{MESSAGES}}` placeholder
  - `scheduleExtractionPrompt`: Customizes datetime extraction (step 5) - uses `{{TODAY_DATE}}` and `{{MESSAGES}}` placeholders
  - `interestMatchingPrompt`: Customizes interest matching logic (step 6) - uses `{{EVENTS}}` and `{{INTERESTS}}` placeholders
  - `eventDescriptionPrompt`: Customizes event description generation (step 7) - uses `{{EVENTS}}` placeholder
  - See config.example.yaml for placeholder documentation and example prompts

**Shared Utilities** (`shared/`):
- `date-utils.ts`: Single source of truth for date normalization, handles GPT's inconsistent formats, exports DATE_FORMAT and MAX_FUTURE_YEARS constants
- `logger.ts`: Logging utilities with verbose mode support (fixed parameter name from `verbose` to `isVerbose`), uses "✗ Discarded:" prefix for filtered messages in verbose mode
- `batch-processor.ts`: Generic batch processing utilities, exports RATE_LIMIT_DELAY constant
- `readline-helper.ts`: Extracts duplicated readline logic from telegram-client, handles password/code prompts (fixed type issues with MutableReadline interface)

**Presentation Layer** (`presentation/`):
- `event-printer.ts`: Console output formatting with emoji icons, sorts events by datetime
- `debug-writer.ts`: Implements IDebugWriter interface, writes 5 debug files (event_detection.json, event_classification.json, schedule_filtering.json, interest_matching.json, event_description.json)

**Authentication** (`data/telegram-client.ts`):
- Uses persistent session storage in `.telegram-session` file
- First run requires phone verification via readline prompts, subsequent runs are automatic
- Session saved only after successful login

**Caching System** (`data/cache.ts`):
- Comprehensive caching with descriptive cache store names
- Six separate cache stores:
  - `telegram_messages`: Raw Telegram messages per source (step 1) - assumes message immutability
  - `messages`: Basic event detection results (step 3)
  - `event_type_classification`: Event type classification results (step 4)
  - `scheduled_events`: Schedule filtering and datetime extraction (step 5)
  - `matching_interests`: Interest matching results (step 6)
  - `events`: Final event object conversion (step 7)
- Message caching strategy: Fetches only new messages since last cached timestamp using minId parameter, combines with cached messages
- Cache keys use message links + hashed preferences for efficient storage
- Hash-based keys prevent cache bloat while maintaining preference isolation

### Important Implementation Details

**Interest Matching:** Uses comprehensive GPT guidelines with mandatory matching rules for specific patterns (e.g., "айти нытьё" → IT networking, karaoke → social events). **Confidence scoring** ensures only high-quality matches: GPT assigns 0.0-1.0 confidence scores to each interest match, with only matches ≥ `minInterestConfidence` (default: 0.75) included in results. This reduces over-matching from ~8% to <3%. **Validation layer** (implemented in `domain/services/interest-matcher.ts`) ensures GPT-returned interest indices are validated against the actual user interest list (filters invalid indices and warns about them), preventing hallucinated categories like "Cultural interests" or "EdTech" from polluting results. Events are processed individually (not batched) to ensure accurate validation.

**Date Handling:** Single source of truth in `normalizeDateTime()` function (`shared/date-utils.ts`) handles GPT's inconsistent date format responses. Normalizes both "dd MMM yyyy HH" and "dd MMM yyyy HH:mm" formats.

**GPT Response Parsing:** Robust parsing handles both structured responses and prose responses like "No messages match any interests."

**Rate Limiting:** 1-second delays between GPT calls via `delay()` function in `shared/batch-processor.ts`. Batch processing with configurable batch sizes (defaults: event detection 16, event type classification 16, schedule filtering 16, event description 5). Interest matching processes events individually for accurate validation.

**Two-Stage GPT Processing:**
1. Basic event detection (`domain/services/event-detector.ts`) - Identifies genuine event announcements
2. Event type classification (`domain/services/event-classifier.ts`) - Classifies as offline/online/hybrid and applies filtering

**Event Type Detection:** GPT classifies each event as offline (in-person), online (virtual), or hybrid, stored in Event.event_type field. Classification uses explicit indicators:
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
- `OPENAI_API_KEY` - OpenAI API key for GPT-5-mini

**Environment Variable Validation:** The application validates all required environment variables at startup before initializing clients. Missing variables will cause immediate failure with a clear error message referencing `.env.example`.

The `.telegram-session` file is automatically created and managed for persistent authentication.

## Cache Management

Cache is stored in `.cache/` directory with separate files per cache store:
- `.cache/telegram_messages.json`: Raw Telegram messages per source (step 1, assumes immutability)
- `.cache/messages.json`: Basic event detection results (step 3, no preferences needed)
- `.cache/event_type_classification.json`: Event type classification results (step 4, no preferences needed)
- `.cache/scheduled_events.json`: Schedule filtering results (step 5, includes timeslots hash)
- `.cache/matching_interests.json`: Interest matching results (step 6, includes interests hash)
- `.cache/events.json`: Final event objects (step 7, includes interests hash)

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
- `interest_matching.json`: Interest matching results showing which events matched which interests (step 6)
- `event_description.json`: Event description generation with extracted titles and summaries (step 7)

Debug files include GPT prompts, responses, cache status, and detailed statistics. Use for troubleshooting event detection, interest matching accuracy, or understanding GPT's decision-making process.

## Architecture Principles

The codebase follows **Clean Architecture** and **DDD** principles:

1. **Separation of Concerns**: Business logic (domain), use cases (application), external systems (data), configuration, and presentation are clearly separated
2. **Single Responsibility**: Each module has one clear purpose
3. **Dependency Injection**: Domain services accept interfaces as parameters, application layer uses constructor injection, bootstrap layer instantiates concrete implementations
4. **Dependency Inversion**: Domain defines interfaces (`IAIClient`, `ICache`, `IMessageSource`, `IDebugWriter`), outer layers implement them
5. **No Code Duplication**: Shared logic extracted to utilities and services
6. **Constants Management**: Configuration constants are centralized in `config/constants.ts` with documented rationale. Operation-specific constants (like `GPT_TEMPERATURE_CREATIVE`, `RATE_LIMIT_DELAY`, `DATE_FORMAT`) stay co-located with their usage context for better maintainability
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
- **Add new domain interfaces**: `domain/interfaces/` (IAIClient, ICache, IMessageSource, IDebugWriter)
- **Change caching logic**: `data/cache.ts` (implements ICache)
- **Modify Telegram fetching**: `data/telegram-client.ts` (implements IMessageSource)
- **Update OpenAI integration**: `data/openai-client.ts` (implements IAIClient)
- **Change pipeline orchestration**: `application/event-pipeline.ts` (uses all domain interfaces)
- **Modify output formatting**: `presentation/event-printer.ts`
- **Change debug file output**: `presentation/debug-writer.ts` (implements IDebugWriter)
- **Add environment variable validation**: `src/index.ts` (validateEnvironmentVariables function)

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
