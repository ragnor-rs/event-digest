export const DEFAULT_CONFIG = {
  maxGroupMessages: 200,
  maxChannelMessages: 100,
  skipOnlineEvents: true,
  writeDebugFiles: false,
  verboseLogging: false,
  minInterestConfidence: 0.75,
  gptBatchSizeEventDetection: 16,
  gptBatchSizeEventClassification: 16,
  gptBatchSizeScheduleExtraction: 16,
  gptBatchSizeEventDescription: 5,

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

CRITICAL: Respond with each qualifying message number, one per line (e.g., "1", "3", "7"). If none qualify, respond with "none".`,

  interestMatchingPrompt: `Match this event to user interests by selecting relevant interest indices with confidence scores.

EVENT:
{{EVENTS}}

INTERESTS:
{{INTERESTS}}

STRICT MATCHING RULES:
- Match ONLY if the event content is DIRECTLY related to the interest topic
- "Communication skills" or "public speaking" ≠ "Speed dating" (professional ≠ romantic)
- "Frontend/React/UI" ≠ "Backend/server/database" (different tech stacks)
- "Networking (professional meetups)" ≠ "Social events (casual parties)"
- When uncertain, prefer NO MATCH over questionable match

RESPONSE FORMAT:
For each match, provide: INDEX:CONFIDENCE
Confidence must be between 0.0 (no match) and 1.0 (perfect match)
Separate multiple matches with commas

Examples:
- Strong matches: 19:0.95, 6:0.85
- Uncertain match: 3:0.60
- No matches: none

IMPORTANT: Only include matches with confidence ≥ 0.75

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

Respond with ONLY the message number and classification index (0, 1, or 2), one per line.
Format: MESSAGE_NUMBER: INDEX`,

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

If you cannot determine the date/time from a message, respond with:
MESSAGE_NUMBER: unknown

IMPORTANT:
- ALWAYS include the COMPLETE datetime: DD Mon YYYY HH:MM
- Always use 24-hour time format (e.g., 14:00, not 2:00 PM)
- Use 3-letter month abbreviations (Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
- Always include leading zeros for days and hours (05, not 5)
- Parse relative dates like "сегодня/today" using the current date
- Parse "завтра/tomorrow" as current date + 1 day
- For partial times like "18" assume "18:00"
- Always ensure the event date is in the future relative to message timestamp
- NEVER return just a time like "19:00" or just a number like "00" - always include the full date`,

  eventDescriptionPrompt: `Convert these event messages into structured event information. Respond in English.

Messages:
{{EVENTS}}

CRITICAL: For each message, respond with EXACTLY this format (including the exact keywords TITLE:, SUMMARY:, DESCRIPTION:):
MESSAGE_NUMBER:
TITLE: [short catchy title in English]
SUMMARY: [1-2 sentence summary in English - DO NOT mention dates/times as they are displayed separately]
DESCRIPTION: [full description from the message, can be original language]

Example:
1:
TITLE: JavaScript Meetup
SUMMARY: Monthly meetup for JS developers to share knowledge and network.
DESCRIPTION: Join us for our monthly JavaScript meetup where we discuss latest trends, share projects, and network with fellow developers.`,
};
