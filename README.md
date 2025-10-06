# Event Digest CLI

A TypeScript CLI tool that generates personalized event digests from Telegram groups and channels using AI-powered filtering.

## Overview

This tool fetches messages from specified Telegram groups and channels, then uses a multi-step AI filtering pipeline to extract events that match your interests and schedule preferences.

## Features

- **YAML Configuration**: Easy-to-manage configuration files with organized settings
- **Smart Event Detection**: Uses GPT to identify genuine event announcements vs general messages
- **Event Type Classification**: Classifies events as offline, online, or hybrid with intelligent location detection
- **High-Accuracy Interest Matching**: 99% accuracy with comprehensive GPT guidelines, mandatory matching rules, and validation to prevent hallucinated interests
- **Schedule Integration**: Filters events by your availability (day of week + time slots)
- **Online Event Filtering**: Option to skip online-only events while including hybrid events
- **Persistent Authentication**: Automatic Telegram session management after initial setup
- **Intelligent Caching**: Reduces API costs by caching both Telegram messages and GPT results with preference-aware cache keys
- **Incremental Message Fetching**: Assumes message immutability, fetches only new messages since last run
- **Multi-Language Support**: Handles events in different languages with configurable cues
- **Debug Mode**: Optional detailed debug files for troubleshooting and analysis

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

You can configure the tool in three ways:

#### Option 1: YAML Configuration (Recommended)

Create a `config.yaml` file in the project root:

```yaml
# Telegram channels to monitor (without @ prefix)
channelsToParse:
  - "city_events"
  - "local_announcements"

# Telegram groups to monitor (without @ prefix)
groupsToParse:
  - "tech_meetups"
  - "community_events"

# Your interests - events will be matched against these topics
userInterests:
  - "Technology"
  - "Music"
  - "Photography"
  - "Board games"

# Weekly availability timeslots
# Format: "DAY_OF_WEEK TIME" where DAY_OF_WEEK is 0-6 (0=Sunday, 6=Saturday)
weeklyTimeslots:
  - "6 14:00"  # Saturday after 14:00
  - "0 14:00"  # Sunday after 14:00

# Maximum number of messages to fetch from groups (default: 200)
maxGroupMessages: 200

# Maximum number of messages to fetch from channels (default: 100)
maxChannelMessages: 100

# Skip online-only events (default: true)
# Hybrid events (both online and offline options) are always included
skipOnlineEvents: true

# Write debug files (default: false)
# When enabled, writes detailed debug files to debug/ directory
writeDebugFiles: false

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
  --write-debug-files false
```

### Configuration Parameters

- `groupsToParse`/`--groups`: Telegram group usernames (without @)
- `channelsToParse`/`--channels`: Telegram channel usernames (without @)
- `userInterests`/`--interests`: Your interests (events must be directly about these topics)
- `weeklyTimeslots`/`--timeslots`: Available time slots in format "DAY HOUR:MINUTE" (0=Sunday, 6=Saturday)
- `maxGroupMessages`/`--max-group-messages`: Maximum messages to fetch per group (default: 200)
- `maxChannelMessages`/`--max-channel-messages`: Maximum messages to fetch per channel (default: 100)
- `skipOnlineEvents`/`--skip-online-events`: Skip online-only events, keep hybrid events (default: true)
- `writeDebugFiles`/`--write-debug-files`: Enable debug file output to debug/ directory (default: false)
- **Custom GPT Prompts** (optional, YAML only):
  - `eventDetectionPrompt`: Custom prompt for event detection (step 3) - uses `{{MESSAGES}}` placeholder
  - `interestMatchingPrompt`: Custom prompt for interest matching (step 5) - uses `{{EVENTS}}`, `{{INTERESTS}}` placeholders
  - `eventTypeClassificationPrompt`: Custom prompt for event classification (step 4) - uses `{{MESSAGES}}` placeholder
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

**Important**: Keep the `.telegram-session` file secure and add it to `.gitignore` to avoid committing sensitive session data.

## How It Works

The tool processes messages through a 7-step pipeline:

1. **Fetch Messages** - Retrieves recent messages from specified Telegram sources
2. **Event Cue Filter** - Filters messages containing date/event keywords
3. **AI Event Detection** - Uses GPT to identify genuine event announcements
4. **Event Type Classification** - Classifies events as offline, online, or hybrid and applies filtering based on skipOnlineEvents
5. **Interest Matching** - Matches events to your specified interests with 99% accuracy using comprehensive guidelines and keyword recognition
6. **Schedule Filtering** - Filters by your available time slots and future dates
7. **Event Conversion** - Converts to structured events with titles, summaries, descriptions

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

## Architecture

- **TypeScript** with strict type checking
- **GramJS** for Telegram API integration
- **OpenAI GPT-4o-mini** for intelligent filtering
- **Comprehensive caching** to minimize API costs
- **Robust error handling** and session management

## Cost Optimization

- Uses GPT-4o-mini (50-100x cheaper than GPT-4)
- Intelligent caching prevents redundant API calls
- Batch processing reduces API requests
- Preference-aware cache invalidation

## Debug Mode

Enable debug file output to troubleshoot interest matching or analyze GPT decisions:

```yaml
writeDebugFiles: true
```

Or via command line:
```bash
npm run dev -- --write-debug-files true
```

This creates four detailed JSON files in the `debug/` directory:
- `event_detection.json`: GPT filtering to identify single event announcements (step 3)
- `event_classification.json`: Event type detection (offline/online/hybrid) (step 4)
- `interest_matching.json`: Interest matching decisions with GPT prompts/responses (step 5)
- `schedule_filtering.json`: Schedule filtering and datetime extraction (step 6)

Each file includes:
- GPT prompts and responses
- Match/discard decisions
- Cache hit statistics
- Invalid interest warnings

## Contributing

This tool processes messages through multiple AI filtering steps. When modifying:

- Test interest matching with both positive and negative examples
- Ensure cache keys include relevant user preferences
- Validate date parsing with various GPT response formats
- Test authentication flow and session persistence
- Verify GPT response validation prevents hallucinated interests

## License

MIT License - see [LICENSE](LICENSE) file for details.