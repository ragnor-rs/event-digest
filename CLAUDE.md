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
  --interests "VC,английский,походы" \
  --timeslots "6 14:00,0 14:00" \
  --max-messages 100
```

## Architecture

This is an event digest CLI that processes Telegram messages through a 7-step filtering pipeline to extract relevant events.

### Core Pipeline Flow
1. **Message Fetching** (`src/telegram.ts`) - Fetches messages from Telegram groups/channels using GramJS
2. **Event Cue Filtering** (`src/filters.ts:filterEventMessages`) - Text-based filtering using configurable cues
3. **GPT Event Detection** (`src/filters.ts:filterWithGPT`) - AI-powered filtering to identify single event announcements
4. **Interest Matching** (`src/filters.ts:filterByInterests`) - Matches events to user interests with strict criteria
5. **Schedule Filtering** (`src/filters.ts:filterBySchedule`) - Filters by datetime and user availability slots
6. **Event Conversion** (`src/events.ts:convertToEvents`) - Converts to structured Event objects with GPT
7. **Output** (`src/events.ts:printEvents`) - Console output of formatted events

### Key Components

**Data Flow Types** (`src/types.ts`):
- `TelegramMessage` → `InterestingMessage` → `ScheduledMessage` → `Event`

**Authentication** (`src/telegram.ts`):
- Uses persistent session storage in `.telegram-session` file
- First run requires phone verification, subsequent runs are automatic

**Caching System** (`src/cache.ts`):
- Comprehensive GPT result caching with interest/schedule-aware cache keys
- Separate cache stores for each pipeline step (steps 3-6)
- Cache keys include user preferences to prevent incorrect hits when settings change

**Configuration** (`src/config.ts`):
- Supports YAML configuration files (config.yaml/config.yml) or command-line arguments
- YAML config provides better organization and version control
- Detailed validation for groups, channels, interests, timeslots, and message limits

### Important Implementation Details

**Interest Matching:** Uses strict GPT criteria to distinguish between events ABOUT a topic vs events merely conducted in a language or mentioning a topic in passing.

**Date Handling:** Single source of truth in `normalizeDateTime()` function handles GPT's inconsistent date format responses.

**GPT Response Parsing:** Robust parsing handles both structured responses and prose responses like "No messages match any interests."

**Rate Limiting:** 1-second delays between GPT calls with batch processing (5-16 messages per batch).

## Environment Setup

Required environment variables (see `.env.example`):
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER` - Telegram API credentials
- `OPENAI_API_KEY` - OpenAI API key for GPT-4o-mini

The `.telegram-session` file is automatically created and managed for persistent authentication.

## Cache Management

Cache is stored in `.cache/gpt-results.json` with step-specific stores. Cache keys include user preferences to ensure correct invalidation when interests or schedule preferences change.