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
  --write-debug-files true
```

## Architecture

This is an event digest CLI that processes Telegram messages through a 7-step filtering pipeline to extract relevant events.

### Core Pipeline Flow
1. **Message Fetching** (`src/telegram.ts`) - Fetches messages from Telegram groups/channels using GramJS
2. **Event Cue Filtering** (`src/filters.ts:filterByEventCues`) - Text-based filtering using configurable cues
3. **GPT Event Detection** (`src/filters.ts:detectEventAnnouncements`) - AI-powered filtering to identify single event announcements, returns Event[] with message field
4. **Event Type Classification** (`src/filters.ts:classifyEventTypes`) - GPT classifies event type (offline/online/hybrid) and applies filtering based on skipOnlineEvents, adds event_type field to Event
5. **Schedule Filtering** (`src/filters.ts:filterBySchedule`) - Filters by datetime and user availability slots, adds start_datetime field to Event
6. **Interest Matching** (`src/filters.ts:filterByInterests`) - Matches events to user interests with strict criteria, adds interests_matched field to Event
7. **Event Description** (`src/events.ts:describeEvents`) - Generates structured event descriptions with GPT, adds event_description field to Event

### Key Components

**Data Flow Types** (`src/types.ts`):
- Single `Event` type with optional fields populated through pipeline stages:
  - Step 3 adds: `message: TelegramMessage`
  - Step 4 adds: `event_type?: 'offline' | 'online' | 'hybrid'`
  - Step 5 adds: `start_datetime?: string`
  - Step 6 adds: `interests_matched?: string[]`
  - Step 7 adds: `event_description?: EventDescription`

**Authentication** (`src/telegram.ts`):
- Uses persistent session storage in `.telegram-session` file
- First run requires phone verification, subsequent runs are automatic

**Caching System** (`src/cache.ts`):
- Comprehensive caching with descriptive cache store names
- Six separate cache stores:
  - `telegram_messages`: Raw Telegram messages per source (step 1) - assumes message immutability
  - `messages`: Basic event detection results (step 3)
  - `event_type_classification`: Event type classification results (step 4)
  - `scheduled_events`: Schedule filtering and datetime extraction (step 5)
  - `matching_interests`: Interest matching results (step 6)
  - `events`: Final event object conversion (step 7)
- Message caching strategy: Fetches only new messages since last cached timestamp, combines with cached messages
- Cache keys use message links + hashed preferences for efficient storage
- Hash-based keys prevent cache bloat while maintaining preference isolation

**Configuration** (`src/config.ts`):
- Supports YAML configuration files (config.yaml/config.yml) or command-line arguments
- YAML config provides better organization and version control
- Detailed validation for groups, channels, interests, timeslots, and message limits
- `skipOnlineEvents` parameter (default: true) excludes online-only events
- `writeDebugFiles` parameter (default: false) enables debug file output to debug/ directory
- **Configurable GPT prompts** (all optional with sensible defaults):
  - `eventDetectionPrompt`: Customizes event detection logic (step 3) - uses `{{MESSAGES}}` placeholder
  - `interestMatchingPrompt`: Customizes interest matching logic (step 5) - uses `{{EVENTS}}` and `{{INTERESTS}}` placeholders
  - `eventTypeClassificationPrompt`: Customizes event type classification (step 4) - uses `{{MESSAGES}}` placeholder
  - See config.example.yaml for placeholder documentation and example prompts

### Important Implementation Details

**Interest Matching:** Uses comprehensive GPT guidelines with mandatory matching rules for specific patterns (e.g., "айти нытьё" → IT networking, karaoke → social events). **Validation layer** (implemented in `src/filters.ts:487-497`) ensures GPT-returned interests are validated against the actual user interest list, preventing hallucinated categories like "Cultural interests" or "EdTech" from polluting results. Events are processed individually (not batched) to ensure accurate validation.

**Date Handling:** Single source of truth in `normalizeDateTime()` function handles GPT's inconsistent date format responses.

**GPT Response Parsing:** Robust parsing handles both structured responses and prose responses like "No messages match any interests."

**Rate Limiting:** 1-second delays between GPT calls. Batch processing: event detection (16 per batch), event type classification (16 per batch), schedule filtering (16 per batch), and event description (5 per batch). Interest matching processes events individually for accurate validation.

**Two-Stage GPT Processing:**
1. Basic event detection (`detectEventAnnouncements`) - Identifies genuine event announcements
2. Event type classification (`classifyEventTypes`) - Classifies as offline/online/hybrid and applies filtering

**Event Type Detection:** GPT classifies each event as offline (in-person), online (virtual), or hybrid, stored in Event.event_type field. Classification uses explicit indicators:
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

Cache is stored in `.cache/` directory with separate files per cache store:
- `.cache/telegram_messages.json`: Raw Telegram messages per source (step 1, assumes immutability)
- `.cache/messages.json`: Basic event detection results (step 3, no preferences needed)
- `.cache/event_type_classification.json`: Event type classification results (step 4, no preferences needed)
- `.cache/scheduled_events.json`: Schedule filtering results (step 5, includes timeslots hash)
- `.cache/matching_interests.json`: Interest matching results (step 6, includes interests hash)
- `.cache/events.json`: Final event objects (step 7, includes interests hash)

**Message Caching Strategy:**
- Messages are assumed to be immutable once published
- On each run, fetches only messages newer than the last cached message timestamp
- Combines cached and newly fetched messages, removing duplicates by message link
- Significantly reduces Telegram API calls on subsequent runs

Cache keys include relevant user preferences to ensure correct invalidation when settings change. Each cache store is maintained in its own file for better organization and independent management.

## Debug Files

When `writeDebugFiles` is enabled (default: false), the tool writes detailed debug information to the `debug/` directory:
- `event_detection.json`: GPT filtering to identify single event announcements (step 3)
- `event_classification.json`: GPT classification of events as hybrid/offline/online with prompts and responses (step 4)
- `schedule_filtering.json`: Schedule filtering and datetime extraction results (step 5)
- `interest_matching.json`: Interest matching results showing which events matched which interests (step 6)

Debug files include GPT prompts, responses, cache status, and detailed statistics. Use for troubleshooting event detection, interest matching accuracy, or understanding GPT's decision-making process.