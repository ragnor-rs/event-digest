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
  --max-group-messages 200 \
  --max-channel-messages 100 \
  --skip-online-events true \
  --write-debug-files true
```

## Architecture

This is an event digest CLI that processes Telegram messages through a 7-step filtering pipeline to extract relevant events.

### Core Pipeline Flow
1. **Message Fetching** (`src/telegram.ts`) - Fetches messages from Telegram groups/channels using GramJS
2. **Event Cue Filtering** (`src/filters.ts:filterEventMessages`) - Text-based filtering using configurable cues
3. **GPT Event Detection** (`src/filters.ts:filterByEventMessages`) - AI-powered filtering to identify single event announcements
4. **Event Type Classification** (`src/filters.ts:convertToEventAnnouncements`) - GPT classifies event type (offline/online/hybrid) and applies offline filtering
5. **Interest Matching** (`src/filters.ts:filterByInterests`) - Matches events to user interests with strict criteria
6. **Schedule Filtering** (`src/filters.ts:filterBySchedule`) - Filters by datetime and user availability slots
7. **Event Conversion** (`src/events.ts:convertToEvents`) - Converts to structured Event objects with GPT
8. **Output** (`src/events.ts:printEvents`) - Console output of formatted events

### Key Components

**Data Flow Types** (`src/types.ts`):
- `TelegramMessage` → `TelegramMessage` → `EventAnnouncement` → `InterestingAnnouncement` → `ScheduledEvent` → `Event`

**Authentication** (`src/telegram.ts`):
- Uses persistent session storage in `.telegram-session` file
- First run requires phone verification, subsequent runs are automatic

**Caching System** (`src/cache.ts`):
- Comprehensive GPT result caching with descriptive cache store names
- Five separate cache stores:
  - `event_messages`: Basic event detection results
  - `announcements`: Event type classification (offline/online/hybrid)
  - `interesting_announcements`: Interest matching results
  - `scheduled_events`: Schedule filtering and datetime extraction
  - `events`: Final event object conversion
- Cache keys use message links + hashed preferences for efficient storage
- Hash-based keys prevent cache bloat while maintaining preference isolation

**Configuration** (`src/config.ts`):
- Supports YAML configuration files (config.yaml/config.yml) or command-line arguments
- YAML config provides better organization and version control
- Detailed validation for groups, channels, interests, timeslots, and message limits
- `skipOnlineEvents` parameter (default: true) excludes online-only events
- `writeDebugFiles` parameter (default: false) enables debug file output to debug/ directory

### Important Implementation Details

**Interest Matching:** Uses comprehensive GPT guidelines with mandatory matching rules for specific patterns (e.g., "айти нытьё" → IT networking, karaoke → social events). Achieved ~99% accuracy through detailed keyword recognition and inclusive matching criteria. **Validation layer** (added in `src/filters.ts:719-765`) ensures GPT-returned interests are validated against the actual user interest list, preventing hallucinated categories like "Cultural interests" or "EdTech" from polluting results.

**Date Handling:** Single source of truth in `normalizeDateTime()` function handles GPT's inconsistent date format responses.

**GPT Response Parsing:** Robust parsing handles both structured responses and prose responses like "No messages match any interests."

**Rate Limiting:** 1-second delays between GPT calls with batch processing (5-16 messages per batch).

**Two-Stage GPT Processing:** 
1. Basic event detection (`filterByEventMessages`) - Identifies genuine event announcements
2. Event type classification (`convertToEventAnnouncements`) - Classifies as offline/online/hybrid and applies filtering

**Event Type Detection:** GPT classifies each event as offline (in-person), online (virtual), or hybrid, stored in EventAnnouncement interface. Classification uses explicit indicators:
- **Offline**: Physical addresses, venue names, city names, Google/Yandex Maps links, office locations
- **Online**: Zoom/Google Meet links, explicit "online" mentions, webinar URLs
- **Hybrid**: Events offering both physical and online participation options

**Online Events Filter:** When `skipOnlineEvents` is enabled (default), only events with physical attendance options are included:
- ✅ **offline events** (in-person only) - always included  
- ✅ **hybrid events** (both in-person and online options) - included because they offer physical attendance
- ❌ **online events** (virtual only) - excluded

This filtering happens during the type classification stage.

## Environment Setup

Required environment variables (see `.env.example`):
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER` - Telegram API credentials
- `OPENAI_API_KEY` - OpenAI API key for GPT-4o-mini

The `.telegram-session` file is automatically created and managed for persistent authentication.

## Cache Management

Cache is stored in `.cache/gpt-results.json` with descriptive cache stores:
- `event_messages`: Stores basic event detection results (no preferences needed)
- `announcements`: Stores event type classification (includes offline events preference)
- `interesting_announcements`: Stores interest matching results (includes interests hash)
- `scheduled_events`: Stores schedule filtering results (includes timeslots hash)
- `events`: Stores final event objects (includes interests hash)

Cache keys include relevant user preferences to ensure correct invalidation when settings change.

## Debug Files

When `writeDebugFiles` is enabled (default: false), the tool writes detailed debug information to the `debug/` directory:
- `event_classification.json`: GPT classification of events as hybrid/offline/online with prompts and responses
- `interest_matching.json`: Interest matching results showing which events matched which interests
- `schedule_filtering.json`: Schedule filtering and datetime extraction results

Debug files include GPT prompts, responses, cache status, and detailed statistics. Use for troubleshooting interest matching accuracy or understanding GPT's decision-making process.