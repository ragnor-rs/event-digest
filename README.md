# Event Digest CLI

A TypeScript CLI tool that generates personalized event digests from Telegram groups and channels using AI-powered filtering.

## Overview

This tool fetches messages from specified Telegram groups and channels, then uses a multi-step AI filtering pipeline to extract events that match your interests and schedule preferences.

## Features

- **Smart Event Detection**: Uses GPT to identify genuine event announcements vs general messages
- **Interest-Based Filtering**: Matches events to your specific interests with strict relevance criteria
- **Schedule Integration**: Filters events by your availability (day of week + time slots)
- **Persistent Authentication**: Automatic Telegram session management after initial setup
- **Intelligent Caching**: Reduces API costs by caching GPT results with preference-aware cache keys
- **Multi-Language Support**: Handles events in different languages with configurable cues

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

Create a `.env` file (use `.env.example` as template):

```env
TELEGRAM_API_ID=your_api_id_here
TELEGRAM_API_HASH=your_api_hash_here
TELEGRAM_PHONE_NUMBER=your_phone_number_here
OPENAI_API_KEY=your_openai_api_key_here
```

## Usage

### Basic Example

```bash
npm run dev -- \
  --groups "tbilisi_js_chat,unicornembassy_georgia" \
  --channels "auditoria_tbilisi,georgiaafisha" \
  --interests "VC,английский,походы" \
  --timeslots "2 12:00,6 13:00,0 13:00" \
  --max-messages 50
```

### Parameters

- `--groups`: Comma-separated list of Telegram group usernames
- `--channels`: Comma-separated list of Telegram channel usernames  
- `--interests`: Your interests (events must be directly about these topics)
- `--timeslots`: Available time slots in format "DAY HOUR:MINUTE" (0=Sunday, 6=Saturday)
- `--max-messages`: Maximum messages to fetch per group/channel (default: 100)

### First Run

On your first run, you'll be prompted to:
1. Enter the verification code sent to your phone
2. Enter your 2FA password (if enabled)

Subsequent runs will use the saved session automatically.

## How It Works

The tool processes messages through a 7-step pipeline:

1. **Fetch Messages** - Retrieves recent messages from specified Telegram sources
2. **Event Cue Filter** - Filters messages containing date/event keywords
3. **AI Event Detection** - Uses GPT to identify genuine event announcements
4. **Interest Matching** - Matches events to your specified interests using strict criteria
5. **Schedule Filtering** - Filters by your available time slots and future dates
6. **Event Conversion** - Converts to structured events with titles, summaries, descriptions
7. **Output** - Displays formatted event digest

## Output Format

```
=== EVENT DIGEST ===

1. JavaScript Meetup
   📅 30 Sep 2025 19:00
   🏷️ английский
   📝 Monthly meetup for JS developers to share knowledge and network.
   🔗 https://t.me/tbilisi_js_chat/12345

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

## Contributing

This tool processes messages through multiple AI filtering steps. When modifying:

- Test interest matching with both positive and negative examples
- Ensure cache keys include relevant user preferences
- Validate date parsing with various GPT response formats
- Test authentication flow and session persistence

## License

MIT License - see [LICENSE](LICENSE) file for details.