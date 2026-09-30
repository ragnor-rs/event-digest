import { ReasoningEffort } from '../domain/interfaces';

export const DEFAULT_CONFIG = {
  maxGroupMessages: 200,
  maxChannelMessages: 100,
  skipOnlineEvents: true,
  writeDebugFiles: false,
  verboseLogging: false,
  // On by default: measured on 48 messages step 5 had written off as
  // "no date/time found", 47 name a date and only omit the hour, so keeping them
  // is nearly all the recall this step was losing. The cost is that a time-less
  // event cannot be checked against weeklyTimeslots and so bypasses that filter.
  includeEventsWithoutTime: true,
  // On by default: aggregator channels repost the same announcement, and a
  // duplicate in the digest is always a defect.
  deduplicateEvents: true,
  // Empty by default: the location step still runs, so the digest gains a venue
  // line without anyone having to declare which city they live in.
  locationFilter: [] as string[],
  // On by default: plenty of announcements assume the city, and dropping them
  // costs more than the occasional out-of-town event it would have caught.
  includeEventsWithoutLocation: true,
  minEventDetectionConfidence: 0.7,
  minEventClassificationConfidence: 0.7,
  minLocationConfidence: 0.7,
  minInterestConfidence: 0.75,
  eventDetectionBatchSize: 16,
  eventClassificationBatchSize: 16,
  scheduleExtractionBatchSize: 16,
  locationExtractionBatchSize: 16,
  eventDescriptionBatchSize: 3,
  sendEventsBatchSize: 5,

  // 'low' keeps reasoning tokens from eating the completion budget on steps that
  // emit one output block per input message. Per-step overrides are unset by default.
  reasoningEffort: 'low' as ReasoningEffort,

  eventMessageCues: {
    ru: [
      'сентябр',
      'сегодня',
      'часов',
      'завтра',
      'послезавтра',
      'январ',
      'феврал',
      'март',
      'апрел',
      'мая',
      'июн',
      'июл',
      'август',
      'октябр',
      'ноябр',
      'декабр',
      'понедельник',
      'вторник',
      'сред',
      'четверг',
      'пятниц',
      'суббот',
      'воскресень',
    ],
    en: [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
      'tonight',
      'tomorrow',
      'today',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ],
  },

  eventDetectionPrompt: `Analyze these messages and identify which ones are announcements for a SINGLE SPECIFIC EVENT.

An event announcement should include:
- A specific date/time (can be relative like "сегодня/today", "завтра/tomorrow", specific times like "19:30", or absolute dates)
- A specific activity, meetup, workshop, presentation, talk, or gathering
- Details about what will happen (even if brief)

INCLUDE messages that:
- Announce workshops, meetups, presentations, talks, networking events, webinars, broadcasts
- Have clear timing information (specific time, date, or relative dates)
- Describe a specific gathering or activity (online or offline)
- Invite people to participate, attend, or join something specific
- Contain meeting links (Zoom, Google Meet, etc.) with scheduled times
- Use words like "приходите/come", "присоединяйтесь/join", "встреча/meeting", "событие/event", "вещать/broadcast"
- Ask people to set calendar reminders or save dates
- Provide specific times with timezone information (МСК, GMT, etc.)

EXCLUDE only messages that:
- Are clearly event digests/roundups listing multiple different events
- Are general announcements without specific timing or scheduling
- Are purely informational posts without inviting participation
- Are job postings, news articles, or promotional content without events

IMPORTANT: Look for timing indicators in ANY language:
- Russian: сегодня, завтра, время, встреча, МСК, вещать
- English: today, tomorrow, time, meeting, at X:XX, broadcast
- Numbers indicating time: 19:30, 14:00, etc.
- Calendar references: "ставьте в календарь", "set reminder", "save the date"

EXAMPLE of what should be INCLUDED:
- A message saying "Today at 19:30 MSK I will broadcast about LinkedIn" with a Zoom link → This IS an event
- A message with "сегодня вещать" + time + meeting link → This IS an event

Messages:
{{MESSAGES}}

RESPONSE FORMAT:
For each qualifying message, provide: MESSAGE_NUMBER:CONFIDENCE
Confidence must be between 0.0 (uncertain) and 1.0 (certain it's an event)
One per line, or "none" if no messages qualify.

Examples:
1:0.95
3:0.80
7:0.70

If none qualify, respond with "none".`,

  interestMatchingPrompt: `Match the event to provided topics by selecting relevant topic indices with confidence scores.

EVENT:
{{EVENTS}}

TOPICS:
{{INTERESTS}}

MATCHING RULES:

1. EXACT TOPIC MATCHING: The event must explicitly discuss or feature the specific topic.
   - Match ONLY if the event explicitly mentions the topic or its commonly known abbreviations
   - Generic broader category terms DO NOT match specific subtopics
   - Require the actual subject matter, not peripheral or related fields

2. PARENTHETICAL CLARIFICATIONS: Text in parentheses provides context, not alternatives.
   - Parentheses clarify WHAT the topic is, not additional match options
   - The event must be about the main topic specifically, as clarified by the parenthetical text

3. EXCLUDE MARKERS: If a topic contains "EXCLUDE:", those subjects must NOT appear in the event.
   - Reject events primarily about excluded subjects
   - Even if the event mentions related terms, reject if the core content is an excluded subject

4. STRICT RELEVANCE: When uncertain, prefer NO MATCH over questionable match.
   - Generic event descriptions without specific details do not match specific topics
   - Related or adjacent fields are NOT matches
   - Peripheral or tangential mentions do not count as matches

5. CONFIDENCE SCORING (0.0-1.0):
   - 0.9-1.0: Event explicitly names the exact topic
   - 0.75-0.89: Event clearly describes the topic without naming it explicitly
   - 0.6-0.74: Event is related but not specific enough
   - Below 0.6: Reject (too weak or uncertain)

RESPONSE FORMAT:
For each match, provide: INDEX:CONFIDENCE
Separate multiple matches with commas

Examples:
- 19:0.95
- 6:0.82
- none

IMPORTANT: Only include matches with confidence ≥ 0.70
When in doubt, respond with "none" rather than forcing a weak match.

Respond with ONLY the index:confidence pairs (comma-separated) or "none".`,

  eventTypeClassificationPrompt: `Classify each event message as offline, online, or hybrid.

CLASSIFICATION OPTIONS:
0: offline - in-person event at a physical location
1: online - virtual event only
2: hybrid - both in-person and online options available

OFFLINE (0):
- Physical addresses, streets, or city names
- Venue names or business locations
- Map links
- Keywords: office, venue, restaurant, bar, location, address

ONLINE (1):
- Only virtual meeting links (Zoom, Google Meet, etc.)
- Explicit "online only" or "webinar"
- No physical location mentioned

HYBRID (2):
- Both physical location AND online access explicitly mentioned
- Both attendance options clearly available

Messages:
{{MESSAGES}}

RESPONSE FORMAT:
For each message, provide: MESSAGE_NUMBER:INDEX:CONFIDENCE
- INDEX: 0 (offline), 1 (online), or 2 (hybrid)
- CONFIDENCE: 0.0-1.0 (how certain you are about the classification)
One per line.

Examples:
1:0:0.95
2:1:0.85
3:2:0.70`,

  scheduleExtractionPrompt: `Extract the start date and time for each event. Today's date is {{TODAY_DATE}}.

CRITICAL: Use message timestamps to infer the correct year for events. If an event mentions "March 15" and the message was posted on "March 10, 2024", the event is "March 15, 2024". If a message from "Dec 10, 2023" mentions "Jan 5", the event is "Jan 5, 2024" (next occurrence).

Messages:
{{MESSAGES}}

For each message, respond with the message number followed by the datetime in this EXACT format:
MESSAGE_NUMBER: DD Mon YYYY HH:MM

CORRECT Examples:
1: 05 Dec 2024 19:30
2: 18 Jan 2025 14:00
3: 07 Oct 2025 20:00

WRONG Examples (DO NOT USE):
1: 19:30 (missing date!)
2: Dec 2024 (missing day and time!)
3: 00 (not a valid datetime!)
4: 19 (not a valid datetime!)

If a message names the date but never states a time, keep the date and mark only the time unknown:
MESSAGE_NUMBER: DD Mon YYYY unknown

Example:
4: 23 Nov 2026 unknown

If you cannot determine even the date from a message, respond with:
MESSAGE_NUMBER: unknown

IMPORTANT:
- ALWAYS include the date: DD Mon YYYY, followed by either HH:MM or the word unknown
- Never invent a time the message does not state - write "unknown" in its place
- Never invent a date either - if the message names no date at all, answer just "unknown"
- Give exactly ONE datetime per message; if several dates are listed, use the first upcoming one
- Always use 24-hour time format (e.g., 14:00, not 2:00 PM)
- Use 3-letter month abbreviations (Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
- Always include leading zeros for days and hours (05, not 5)
- Parse relative dates like "сегодня/today" using the current date
- Parse "завтра/tomorrow" as current date + 1 day
- For partial times like "18" assume "18:00"
- Always ensure the event date is in the future relative to message timestamp
- NEVER return just a time like "19:00" or just a number like "00" - always include the full date`,

  locationExtractionPrompt: `Extract where each event takes place, and decide which of the wanted locations it falls in.

WANTED LOCATIONS:
{{LOCATIONS}}

Messages:
{{MESSAGES}}

For each message, respond with ONE line in this EXACT pipe-separated format:
MESSAGE_NUMBER|VENUE|ADDRESS|INDEX|CONFIDENCE

- VENUE: the name of the place as written in the message (e.g. Fabrika, Impact Hub, Cafe Linville). Use "unknown" if no venue is named.
- ADDRESS: the street address or district as written (e.g. Egnate Ninoshvili St 8, Vake). Use "unknown" if no address is given.
- INDEX: the number of the wanted location this event is in, or -1 if it is in none of them, if the location cannot be determined, or if the wanted list is empty.
- CONFIDENCE: 0.0-1.0, how certain you are about INDEX (not about the venue name).

CRITICAL — a street address, venue or district almost never names its city. Use what you know about the world to resolve it:
- "Rustaveli Ave 12" or "Fabrika" or "Vake" are in Tbilisi
- "Batumi Blvd" is in Batumi
- A venue you recognise resolves to the city it is in, even if the message never says the city
- Only fall back to -1 when the message genuinely gives no usable place

Use pipes ONLY as field separators. If a venue or address contains a pipe, replace it with a comma.
Output ONLY these lines, one per message, no preamble and no commentary.

CORRECT Examples (assuming 0: Tbilisi, 1: Batumi):
1|Fabrika|Egnate Ninoshvili St 8|0|0.95
2|unknown|Rustaveli Ave 12|0|0.85
3|Black Sea Arena|Shekvetili|-1|0.90
4|unknown|unknown|-1|0.0

WRONG Examples (DO NOT USE):
1: Fabrika, Tbilisi (wrong separator — use pipes!)
2|Fabrika|Egnate Ninoshvili St 8 (missing INDEX and CONFIDENCE!)
3|Tbilisi|Tbilisi|0|0.9 (the city is not a venue — use "unknown" when no venue is named)
4|Fabrika|Egnate Ninoshvili St 8|Tbilisi|0.9 (INDEX must be a number, not a name!)`,

  eventDescriptionPrompt: `You will receive N numbered event messages. Output exactly N structured blocks — one per message, in input order. Do not stop until every numbered message has a block.

Messages:
{{EVENTS}}

For each message, output a block in EXACTLY this format (use the exact keywords TITLE:, SUMMARY:, DESCRIPTION:; replace [number] with the actual message number):
[number]:
TITLE: [short catchy title in English]
SUMMARY: [1-2 sentence summary in English — DO NOT mention dates/times as they are displayed separately]
DESCRIPTION: [full description from the message, can be original language]

Output ONLY the blocks. No preamble, no commentary, no closing remarks. Respond in English.

Example for 2 input messages:
1:
TITLE: JavaScript Meetup
SUMMARY: Monthly meetup for JS developers to share knowledge and network.
DESCRIPTION: Join us for our monthly JavaScript meetup where we discuss latest trends, share projects, and network with fellow developers.

2:
TITLE: Tea Tasting Workshop
SUMMARY: Hands-on tea tasting with explanations of brewing rules and types.
DESCRIPTION: An engaging tea meetup featuring guided tastings and curated selections.

The number of blocks in your response MUST equal the number of messages above. After the final block, stop.`,
};
