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
  --min-event-detection-confidence 0.7 \
  --min-event-classification-confidence 0.7 \
  --min-interest-confidence 0.75 \
  --event-detection-batch-size 16 \
  --event-classification-batch-size 16 \
  --schedule-extraction-batch-size 16 \
  --event-description-batch-size 5 \
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

This is an event digest CLI that processes Telegram messages through a 7-step filtering pipeline to extract relevant events. The codebase follows **Clean Architecture** and **Domain-Driven Design (DDD)** principles.

### Project Structure

```
src/
├── domain/                         # Business logic & domain entities
│   ├── entities/                   # Domain entities (DigestEvent, SourceMessage, etc.)
│   │   ├── digest-event.ts         # Core DigestEvent entity with optional fields
│   │   ├── source-message.ts       # Raw message data from any source
│   │   ├── interest-match.ts       # Interest match with confidence score
│   │   ├── event-type-classification.ts  # Event type classification with confidence
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
│   │   ├── event-detector.ts       # Step 3: GPT event detection (~204 lines)
│   │   ├── event-classifier.ts     # Step 4: Event type classification
│   │   ├── schedule-matcher.ts     # Step 5: Schedule extraction & matching (~417 lines, longest service)
│   │   ├── interest-matcher.ts     # Step 6: Interest matching with confidence (~245 lines, processes individually)
│   │   ├── event-describer.ts      # Step 7: Event description generation
│   │   └── index.ts                # Barrel export
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
├── shared/                         # Shared utilities & cross-cutting concerns
│   ├── date-utils.ts               # Date normalization (single source of truth)
│   ├── logger.ts                   # Logging utilities (verbose/normal)
│   ├── batch-processor.ts          # Batch processing & rate limiting
│   ├── readline-helper.ts          # Input prompts for Telegram auth
│   ├── debug-writer.ts             # Debug file writer (5 files)
│   ├── types/                      # Shared types
│   │   ├── debug-entries.ts        # Debug entry type definitions
│   │   └── index.ts                # Barrel export
│   └── index.ts                    # Barrel export
├── presentation/                   # Output formatting
│   ├── event-reporter.interface.ts # IEventReporter interface for output
│   ├── event-printer.ts            # Console event output formatting
│   └── event-sender.ts             # Telegram message sending
└── index.ts                        # Application bootstrap
```

### Core Pipeline Flow

The pipeline is orchestrated by `application/event-pipeline.ts` which coordinates all domain services:

1. **Message Fetching** (`data/telegram-client.ts`) - Fetches messages from Telegram groups/channels using GramJS with incremental fetching via minId parameter
2. **Event Cue Filtering** (`domain/services/event-cues-filter.ts`) - Text-based filtering using configurable date/time keywords
3. **GPT Event Detection** (`domain/services/event-detector.ts`) - AI-powered filtering to identify single event announcements, returns DigestEvent[] with message field and event_detection_confidence (0.0-1.0 score)
4. **Event Type Classification** (`domain/services/event-classifier.ts`) - GPT classifies event type (offline/online/hybrid) and applies filtering based on skipOnlineEvents, adds event_type_classification field (EventTypeClassification with type and confidence) to DigestEvent
5. **Schedule Filtering** (`domain/services/schedule-matcher.ts`) - Extracts datetime with GPT, filters by user availability slots, adds start_datetime field to DigestEvent
6. **Interest Matching** (`domain/services/interest-matcher.ts`) - Matches events to user interests with confidence scoring and validation, adds interest_matches field to DigestEvent
7. **Event Description** (`domain/services/event-describer.ts`) - Generates structured event descriptions with GPT, adds event_description field (DigestEventDescription type) to DigestEvent

### Key Components

**Domain Entities** (`domain/entities/`):
- `SourceMessage`: Raw message data from any source (timestamp, content, link)
- `InterestMatch`: Interest matching result with confidence score (0.0-1.0)
- `EventTypeClassification`: Event type classification result with type (AttendanceMode) and confidence (0.0-1.0)
- `DigestEventDescription`: Structured event information (title, short_summary)
- `DigestEvent`: Single event type with optional fields populated through pipeline stages:
  - Step 3 adds: `message: SourceMessage` and `event_detection_confidence?: number` (0.0-1.0 confidence score)
  - Step 4 adds: `event_type_classification?: EventTypeClassification` (contains type: AttendanceMode enum and confidence: number)
  - Step 5 adds: `start_datetime?: Date`
  - Step 6 adds: `interest_matches?: InterestMatch[]` (with confidence scores)
  - Step 7 adds: `event_description?: DigestEventDescription`
- `AttendanceMode`: Enum defining how attendees can participate (OFFLINE = 'offline', ONLINE = 'online', HYBRID = 'hybrid')

**Domain Services** (`domain/services/`):
- `event-cues-filter.ts`: Text-based event filtering using keyword matching (Russian/English date keywords)
- `event-detector.ts`: GPT-powered event announcement detection with confidence scoring (204 lines), uses aiClient.call()
- `event-classifier.ts`: Event type classification (offline/online/hybrid) with confidence-based filtering (265 lines), uses aiClient.call()
- `schedule-matcher.ts`: Schedule extraction and availability matching (417 lines, longest service), uses aiClient.call()
- `interest-matcher.ts`: Interest matching with confidence scoring and validation (245 lines, processes individually for accuracy), uses aiClient.call()
- `event-describer.ts`: Event description generation (190 lines), uses aiClient.callCreative() (same temperature 1.0 as other operations)

**Application Layer** (`application/`):
- `event-pipeline.ts`: Orchestrates entire 7-step pipeline with dependency injection (IAIClient, ICache, IMessageSource, DebugWriter), coordinates all domain services, manages debug file writing, provides step-by-step progress logging (e.g., "Step 3/7: Detecting event announcements...")

**Data Layer** (`data/`):
- `openai-client.ts`: OpenAI GPT API wrapper implementing IAIClient interface, rate limiting (1-second delays), uses GPT-5-mini model with temperature 1.0 for all operations (both standard and creative), exposes GPT_TEMPERATURE_CREATIVE constant (also 1.0), includes retry logic with exponential backoff for rate limit errors (max 3 retries: 2s, 4s, 8s delays)
- `telegram-client.ts`: Telegram API client implementing IMessageSource interface (fetchMessages and sendMessage methods), session management, uses readline-helper for authentication prompts
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
- **Configurable confidence thresholds** (all optional with defaults optimized for quality filtering):
  - `minEventDetectionConfidence` (default: 0.7): Minimum confidence (0.0-1.0) for step 3 event detection; higher values = fewer but more certain events
  - `minEventClassificationConfidence` (default: 0.7): Minimum confidence (0.0-1.0) for step 4 event type classification; higher values = stricter classification
  - `minInterestConfidence` (default: 0.75): Minimum confidence (0.0-1.0) for step 6 interest matching; GPT assigns scores, only matches ≥ threshold are included
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
- **Event Delivery** (optional):
  - `sendEventsRecipient` (no default): Telegram recipient for event delivery (e.g., @username or chat ID); when configured, events are sent to this recipient instead of being printed to console. When undefined (default), events are printed to console.
  - `sendEventsBatchSize` (default: 5): Number of events to send per Telegram message batch

**Shared Layer** (`shared/`):
- `date-utils.ts`: Single source of truth for date normalization, handles GPT's inconsistent formats, exports DATE_FORMAT and MAX_FUTURE_YEARS constants
- `logger.ts`: Logging utilities with verbose mode support (fixed parameter name from `verbose` to `isVerbose`), uses "✗ Discarded:" prefix for filtered messages in verbose mode
- `batch-processor.ts`: Generic batch processing utilities, exports RATE_LIMIT_DELAY constant
- `readline-helper.ts`: Extracts duplicated readline logic from telegram-client, handles password/code prompts (fixed type issues with MutableReadline interface)
- `debug-writer.ts`: Concrete implementation for debug file writing, writes 5 debug files (event_detection.json, event_classification.json, schedule_filtering.json, interest_matching.json, event_description.json). Like Logger, this is a concrete class used directly (not abstracted behind an interface)
- `types/debug-entries.ts`: Debug entry type definitions using primitive types (DebugEventDetectionEntry, DebugTypeClassificationEntry, DebugScheduleFilteringEntry, DebugInterestMatchingEntry, DebugEventDescriptionEntry) - uses primitives instead of domain entities to maintain clean architecture boundaries

**Presentation Layer** (`presentation/`):
- `event-reporter.interface.ts`: IEventReporter interface defining report() method for event output
- `event-printer.ts`: Console output formatting with emoji icons, sorts events by datetime, implements IEventReporter
- `event-sender.ts`: Telegram message sending with batch support, formats events as structured Telegram messages, implements IEventReporter

**Authentication** (`data/telegram-client.ts`):
- Uses persistent session storage in `.telegram-session` file
- First run requires phone verification via readline prompts, subsequent runs are automatic
- Session saved only after successful login

**Caching System** (`data/cache.ts`):
- Comprehensive caching with descriptive cache store names
- Six separate cache stores:
  - `telegram_messages`: Raw Telegram messages per source (step 1) - assumes message immutability
  - `messages`: Event detection boolean decisions (step 3) - stores whether each message is an event
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
- `OPENAI_API_KEY` - OpenAI API key for GPT-5-mini model

**Environment Variable Validation:** The application validates all required environment variables at startup before initializing clients. Missing variables will cause immediate failure with a clear error message referencing `.env.example`.

The `.telegram-session` file is automatically created and managed for persistent authentication.

## Cache Management

Cache is stored in `.cache/` directory with separate files per cache store:
- `.cache/telegram_messages.json`: Raw Telegram messages per source (step 1, assumes immutability)
- `.cache/messages.json`: Event detection boolean decisions (step 3, no preferences needed) - stores whether each message is an event
- `.cache/event_type_classification.json`: Event type classification results (step 4, no preferences needed)
- `.cache/scheduled_events.json`: Schedule filtering results (step 5, no preferences in cache key)
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
4. **Dependency Inversion**: Domain defines interfaces (`IAIClient`, `ICache`, `IMessageSource`), outer layers implement them
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
- **Add new domain interfaces**: `domain/interfaces/` (IAIClient, ICache, IMessageSource)
- **Change caching logic**: `data/cache.ts` (implements ICache)
- **Modify Telegram fetching**: `data/telegram-client.ts` (implements IMessageSource)
- **Update OpenAI integration**: `data/openai-client.ts` (implements IAIClient)
- **Change pipeline orchestration**: `application/event-pipeline.ts` (uses all domain interfaces)
- **Add new presentation interfaces**: `presentation/event-reporter.interface.ts` (IEventReporter)
- **Modify output formatting**: `presentation/event-printer.ts` (implements IEventReporter)
- **Modify event sending logic**: `presentation/event-sender.ts` (implements IEventReporter)
- **Change debug file output**: `shared/debug-writer.ts`
- **Add environment variable validation**: `src/index.ts` (validateEnvironmentVariables function)

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
