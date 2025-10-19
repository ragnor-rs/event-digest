# Event Digest CLI

A TypeScript CLI tool that generates personalized event digests from Telegram groups and channels using AI-powered filtering.

## Overview

This tool fetches messages from specified Telegram groups and channels, then uses a multi-step AI filtering pipeline to extract events that match your interests and schedule preferences.

## Features

- **YAML Configuration**: Easy-to-manage configuration files with organized settings
- **Clean Architecture**: Domain-Driven Design with clear separation of concerns
- **Smart Event Detection**: Uses GPT to identify genuine event announcements vs general messages
- **Event Type Classification**: Classifies events as offline, online, or hybrid with intelligent location detection
- **High-Accuracy Interest Matching**: Comprehensive GPT guidelines with mandatory matching rules and validation to prevent hallucinated interests
- **Confidence Scoring**: Configurable threshold (default 0.75) ensures only high-quality interest matches
- **Schedule Integration**: Filters events by your availability (day of week + time slots)
- **Online Event Filtering**: Option to skip online-only events while including hybrid events
- **Persistent Authentication**: Automatic Telegram session management after initial setup
- **Intelligent Caching**: Six-tier caching system reduces API costs by caching both Telegram messages and GPT results with preference-aware keys
- **Incremental Message Fetching**: Uses minId parameter to fetch only messages with ID greater than last cached message ID
- **Multi-Language Support**: Handles events in different languages with configurable cues
- **Debug Mode**: Optional detailed debug files for troubleshooting and analysis
- **Configurable Batch Processing**: Tune GPT batch sizes for optimal speed/accuracy balance

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
# Use specific interests for better accuracy
# Hierarchical format: "Music (Jazz, Classical)" matches any subcategory
userInterests:
  - "React/Frontend development"
  - "Photography (Street photography, Portraits)"
  - "Board games (Strategy games, D&D)"
  - "Professional networking (Tech meetups)"
  - "Jazz concerts"
# See config.example.yaml for detailed tips and examples

# Weekly availability timeslots
# Format: "DAY_OF_WEEK TIME" where DAY_OF_WEEK is 0-6 (0=Sunday, 6=Saturday)
weeklyTimeslots:
  - "6 14:00"  # Saturday after 14:00
  - "0 14:00"  # Sunday after 14:00

# Maximum number of messages to fetch from groups
# Default: 200 (when only this value is unspecified but maxChannelMessages is specified)
#          300 (when both limits unspecified: base value 200 is multiplied by GROUP_MESSAGE_MULTIPLIER=1.5)
maxGroupMessages: 200

# Maximum number of messages to fetch from channels
# Default: 100
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

# Minimum confidence thresholds for AI filtering (0.0-1.0)
# GPT assigns confidence scores to predictions; only results above threshold are included

# Minimum confidence for event detection (default: 0.7)
# Controls which messages are classified as events
minEventDetectionConfidence: 0.7

# Minimum confidence for event type classification (default: 0.7)
# Controls confidence in offline/online/hybrid classification
minEventClassificationConfidence: 0.7

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
eventDescriptionBatchSize: 5     # Step 7: Event description generation

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
  --max-group-messages 200 \
  --max-channel-messages 100 \
  --skip-online-events true \
  --write-debug-files false \
  --verbose-logging false \
  --min-event-detection-confidence 0.7 \
  --min-event-classification-confidence 0.7 \
  --min-interest-confidence 0.75 \
  --event-detection-batch-size 16 \
  --event-classification-batch-size 16 \
  --schedule-extraction-batch-size 16 \
  --event-description-batch-size 5
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

**Be Specific**
- ❌ Too broad: `"Technology"`, `"Music"`, `"Sports"`
- ✅ Specific: `"React/Frontend development"`, `"Jazz concerts"`, `"Trail running"`

**Use Hierarchical Format**
- Format: `"Parent category (Subcategory 1, Subcategory 2)"`
- Example: `"Electronic music (Electro Swing, Glitch Hop)"`
- Matches events about the parent OR any subcategory

**Distinguish Context**
- ❌ Unclear: `"Networking"`
- ✅ Clear: `"Professional networking (Tech industry)"` vs `"Social gatherings"`

**Separate Similar Interests**
- Consumption vs Creation: `"Music concerts"` vs `"Music production workshops"`
- Different stacks: `"React/Frontend"` vs `"Python/Backend"`

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
- `maxGroupMessages`/`--max-group-messages`: Maximum messages to fetch per group (default: 200, or 300 if both limits unspecified)
- `maxChannelMessages`/`--max-channel-messages`: Maximum messages to fetch per channel (default: 100)
- `skipOnlineEvents`/`--skip-online-events`: Skip online-only events, keep hybrid events (default: true)
- `writeDebugFiles`/`--write-debug-files`: Enable debug file output to debug/ directory (default: false)
- `verboseLogging`/`--verbose-logging`: Enable detailed logging with cache stats, batch numbers, and DISCARDED message links (default: false)
- **Confidence Thresholds** (optional - controls AI quality filtering):
  - `minEventDetectionConfidence`/`--min-event-detection-confidence`: Minimum confidence (0.0-1.0) for event detection; higher values = fewer but more certain events (default: 0.7)
  - `minEventClassificationConfidence`/`--min-event-classification-confidence`: Minimum confidence (0.0-1.0) for event type classification; higher values = stricter classification (default: 0.7)
  - `minInterestConfidence`/`--min-interest-confidence`: Minimum confidence (0.0-1.0) for interest matching; higher values = fewer but more certain matches (default: 0.75)
- **GPT Batch Sizes** (optional - controls processing efficiency):
  - `eventDetectionBatchSize`/`--event-detection-batch-size`: Items per batch for event detection (default: 16)
  - `eventClassificationBatchSize`/`--event-classification-batch-size`: Items per batch for event type classification (default: 16)
  - `scheduleExtractionBatchSize`/`--schedule-extraction-batch-size`: Items per batch for schedule extraction (default: 16)
  - `eventDescriptionBatchSize`/`--event-description-batch-size`: Items per batch for event description generation (default: 5)
- **Custom GPT Prompts** (optional, YAML only - all 5 AI steps configurable):
  - `eventDetectionPrompt`: Custom prompt for event detection (step 3) - uses `{{MESSAGES}}` placeholder
  - `eventTypeClassificationPrompt`: Custom prompt for event type classification (step 4) - uses `{{MESSAGES}}` placeholder
  - `scheduleExtractionPrompt`: Custom prompt for datetime extraction (step 5) - uses `{{TODAY_DATE}}`, `{{MESSAGES}}` placeholders
  - `interestMatchingPrompt`: Custom prompt for interest matching (step 6) - uses `{{EVENTS}}`, `{{INTERESTS}}` placeholders
  - `eventDescriptionPrompt`: Custom prompt for event description generation (step 7) - uses `{{EVENTS}}` placeholder
  - See config.example.yaml for detailed documentation and examples
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

## How It Works

The tool processes messages through a 7-step pipeline:

1. **Fetch Messages** (`data/telegram-client.ts`) - Retrieves recent messages from specified Telegram sources
2. **Event Cue Filter** (`domain/services/event-cues-filter.ts`) - Filters messages containing date/event keywords
3. **AI Event Detection** (`domain/services/event-detector.ts`) - Uses GPT to identify genuine event announcements, creates DigestEvent objects with message field and event_detection_confidence (0.0-1.0 score)
4. **Event Type Classification** (`domain/services/event-classifier.ts`) - Classifies events as offline, online, or hybrid and applies filtering based on skipOnlineEvents, adds event_type_classification field (EventTypeClassification with type and confidence)
5. **Schedule Filtering** (`domain/services/schedule-matcher.ts`) - Filters by your available time slots and future dates, adds start_datetime field (Date object)
6. **Interest Matching** (`domain/services/interest-matcher.ts`) - Matches events to your specified interests using comprehensive guidelines and validation to prevent hallucinated categories, adds interest_matches field (with confidence scores)
7. **Event Description** (`domain/services/event-describer.ts`) - Generates structured event descriptions with titles and summaries using GPT, adds event_description field (DigestEventDescription type with title and short_summary)

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
│   └── event-pipeline.ts       # 7-step pipeline orchestrator
├── data/                       # External systems (infrastructure layer)
│   ├── openai-client.ts        # OpenAI API client
│   ├── telegram-client.ts      # Telegram API client
│   └── cache.ts                # Caching system
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
│   └── event-printer.ts        # Console event output
└── index.ts                    # Application bootstrap
```

### Key Technologies

- **TypeScript** with strict type checking
- **GramJS** for Telegram API integration
- **OpenAI GPT-5-mini** for intelligent filtering with temperature 1.0
- **date-fns** for date parsing and manipulation
- **js-yaml** for YAML configuration support
- **Comprehensive caching** to minimize API costs

## Output Format

```
=== EVENT DIGEST ===

1. Tech Meetup
   📅 30 Sep 2025 19:00
   🏷️ Technology
   📝 Monthly meetup for tech enthusiasts to share knowledge and network.
   🔗 https://t.me/tech_meetups/12345

Total events found: 1
```

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

- Uses GPT-5-mini with temperature 1.0 for optimal balance of creativity and accuracy
- Intelligent six-tier caching prevents redundant API calls
- Configurable batch processing (defaults: event detection 16, classification 16, schedule filtering 16, description generation 5)
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

This creates five detailed JSON files in the `debug/` directory:
- `event_detection.json`: GPT filtering to identify single event announcements (step 3)
- `event_classification.json`: Event type detection (offline/online/hybrid) (step 4)
- `schedule_filtering.json`: Schedule filtering and datetime extraction (step 5)
- `interest_matching.json`: Interest matching decisions with GPT prompts/responses (step 6)
- `event_description.json`: Event description generation with extracted titles and summaries (step 7)

Each file includes:
- GPT prompts and responses
- Match/discard decisions
- Cache hit statistics
- Extraction success rates
- Invalid interest warnings (step 6)

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
