import { Config } from './types';
import * as yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

function loadYamlConfig(filePath: string): Partial<Config> | null {
  try {
    if (fs.existsSync(filePath)) {
      const yamlContent = fs.readFileSync(filePath, 'utf-8');
      const config = yaml.load(yamlContent) as Partial<Config>;
      console.log(`Loaded configuration from ${filePath}`);
      return config;
    }
  } catch (error) {
    console.error(`Error loading YAML config from ${filePath}:`, error);
  }
  return null;
}

export function parseArgs(): Config {
  const args = process.argv.slice(2);
  
  // Check for YAML config file first
  const configArg = args.find(arg => arg.startsWith('--config='));
  if (configArg) {
    const configPath = configArg.split('=')[1];
    const yamlConfig = loadYamlConfig(configPath);
    if (yamlConfig) {
      return validateAndCompleteConfig(yamlConfig);
    }
  }
  
  // Check for default config.yaml
  const defaultConfigPaths = [
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config.yml')
  ];
  
  for (const configPath of defaultConfigPaths) {
    const yamlConfig = loadYamlConfig(configPath);
    if (yamlConfig) {
      return validateAndCompleteConfig(yamlConfig);
    }
  }
  
  // Fall back to command line arguments
  if (args.length === 0) {
    console.log(`Usage:
  Option 1 - YAML config file:
    npm run dev -- --config=config.yaml

  Option 2 - Command line arguments:
    npm run dev -- \\
      --groups "group1,group2" \\
      --channels "channel1,channel2" \\
      --interests "Interest1,Interest2" \\
      --timeslots "6 14:00,0 14:00" \\
      [--max-group-messages 200] \\
      [--max-channel-messages 100] \\
      [--skip-online-events true] \\
      [--write-debug-files false] \\
      [--verbose-logging false] \\
      [--gpt-batch-size-event-detection 16] \\
      [--gpt-batch-size-event-classification 16] \\
      [--gpt-batch-size-schedule-extraction 16] \\
      [--gpt-batch-size-event-description 5] \\
      [--last-timestamp "2011-08-12T20:17:46.384Z"] \\
      [--max-messages 100]

  Option 3 - Default config file (config.yaml or config.yml in project root)`);
    process.exit(1);
  }

  const config: Partial<Config> = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    
    switch (key) {
      case '--groups':
        config.groupsToParse = value.split(',').map(s => s.trim());
        break;
      case '--channels':
        config.channelsToParse = value.split(',').map(s => s.trim());
        break;
      case '--interests':
        config.userInterests = value.split(',').map(s => s.trim());
        break;
      case '--timeslots':
        config.weeklyTimeslots = value.split(',').map(s => s.trim());
        break;
      case '--last-timestamp':
        config.lastGenerationTimestamp = value;
        break;
      case '--max-messages':
        config.maxInputMessages = parseInt(value);
        break;
      case '--max-group-messages':
        config.maxGroupMessages = parseInt(value);
        break;
      case '--max-channel-messages':
        config.maxChannelMessages = parseInt(value);
        break;
      case '--write-debug-files':
        config.writeDebugFiles = value.toLowerCase() === 'true';
        break;
      case '--skip-online-events':
        config.skipOnlineEvents = value.toLowerCase() === 'true';
        break;
      case '--verbose-logging':
        config.verboseLogging = value.toLowerCase() === 'true';
        break;
      case '--gpt-batch-size-event-detection':
        config.gptBatchSizeEventDetection = parseInt(value);
        break;
      case '--gpt-batch-size-event-classification':
        config.gptBatchSizeEventClassification = parseInt(value);
        break;
      case '--gpt-batch-size-schedule-extraction':
        config.gptBatchSizeScheduleExtraction = parseInt(value);
        break;
      case '--gpt-batch-size-event-description':
        config.gptBatchSizeEventDescription = parseInt(value);
        break;
    }
  }

  return validateAndCompleteConfig(config);
}

function validateAndCompleteConfig(config: Partial<Config>): Config {
  // Track which values were provided vs defaulted
  const providedMaxGroupMessages = config.maxGroupMessages !== undefined;
  const providedMaxChannelMessages = config.maxChannelMessages !== undefined;
  const providedSkipOnlineEvents = config.skipOnlineEvents !== undefined;
  const providedWriteDebugFiles = config.writeDebugFiles !== undefined;
  const providedVerboseLogging = config.verboseLogging !== undefined;
  const providedEventMessageCues = config.eventMessageCues !== undefined;
  const providedGptBatchSizeEventDetection = config.gptBatchSizeEventDetection !== undefined;
  const providedGptBatchSizeEventClassification = config.gptBatchSizeEventClassification !== undefined;
  const providedGptBatchSizeScheduleExtraction = config.gptBatchSizeScheduleExtraction !== undefined;
  const providedGptBatchSizeEventDescription = config.gptBatchSizeEventDescription !== undefined;
  const providedEventDetectionPrompt = config.eventDetectionPrompt !== undefined;
  const providedInterestMatchingPrompt = config.interestMatchingPrompt !== undefined;
  const providedEventTypeClassificationPrompt = config.eventTypeClassificationPrompt !== undefined;
  const providedScheduleExtractionPrompt = config.scheduleExtractionPrompt !== undefined;
  const providedEventDescriptionPrompt = config.eventDescriptionPrompt !== undefined;

  // Set defaults for separate limits
  if (config.maxGroupMessages === undefined && config.maxChannelMessages === undefined) {
    // If neither is specified, use legacy maxInputMessages or defaults
    const legacyLimit = config.maxInputMessages || 100;
    config.maxGroupMessages = Math.floor(legacyLimit * 1.5); // Groups need more messages due to noise
    config.maxChannelMessages = legacyLimit;
  } else {
    // Set individual defaults if only one is specified
    if (config.maxGroupMessages === undefined) {
      config.maxGroupMessages = 200;
    }
    if (config.maxChannelMessages === undefined) {
      config.maxChannelMessages = 100;
    }
  }


  if (!config.eventMessageCues) {
    config.eventMessageCues = {
      ru: ["сентябр", "сегодня", "часов", "завтра", "послезавтра", "январ", "феврал", "март", "апрел", "мая", "июн", "июл", "август", "октябр", "ноябр", "декабр", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот", "воскресень"],
      en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "tonight", "tomorrow", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    };
  }

  // Set default for skip online events
  if (config.skipOnlineEvents === undefined) {
    config.skipOnlineEvents = true;
  }

  // Set default for write debug files
  if (config.writeDebugFiles === undefined) {
    config.writeDebugFiles = false;
  }

  // Set default for verbose logging
  if (config.verboseLogging === undefined) {
    config.verboseLogging = false;
  }

  // Set default GPT batch sizes
  if (config.gptBatchSizeEventDetection === undefined) {
    config.gptBatchSizeEventDetection = 16;
  }
  if (config.gptBatchSizeEventClassification === undefined) {
    config.gptBatchSizeEventClassification = 16;
  }
  if (config.gptBatchSizeScheduleExtraction === undefined) {
    config.gptBatchSizeScheduleExtraction = 16;
  }
  if (config.gptBatchSizeEventDescription === undefined) {
    config.gptBatchSizeEventDescription = 5;
  }

  // Set default event detection prompt
  if (!config.eventDetectionPrompt) {
    config.eventDetectionPrompt = `Analyze these messages and identify which ones are announcements for a SINGLE SPECIFIC EVENT.

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

CRITICAL: Respond with each qualifying message number, one per line (e.g., "1", "3", "7"). If none qualify, respond with "none".`;
  }

  // Set default interest matching prompt
  if (!config.interestMatchingPrompt) {
    config.interestMatchingPrompt = `Match this event to user interests by selecting relevant interest indices.

EVENT:
{{EVENTS}}

INTERESTS:
{{INTERESTS}}

Match the event if it is directly related to any of the interest topics.

RESPONSE FORMAT:
Respond with a comma-separated list of interest indices that match the event.
Example: 0, 3, 7
If no interests match, respond with: none

Respond with ONLY the comma-separated interest indices or "none".`;
  }

  // Set default event type classification prompt
  if (!config.eventTypeClassificationPrompt) {
    config.eventTypeClassificationPrompt = `Classify each event message as offline, online, or hybrid.

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
Format: MESSAGE_NUMBER: INDEX`;
  }

  // Set default schedule extraction prompt
  if (!config.scheduleExtractionPrompt) {
    config.scheduleExtractionPrompt = `Extract the start date and time for each event. Today's date is {{TODAY_DATE}}.

CRITICAL: Use message timestamps to infer the correct year for events. If an event mentions "March 15" and the message was posted on "March 10, 2024", the event is "March 15, 2024". If a message from "Dec 10, 2023" mentions "Jan 5", the event is "Jan 5, 2024" (next occurrence).

Messages:
{{MESSAGES}}

For each message, respond with the message number followed by the datetime in this EXACT format:
MESSAGE_NUMBER: DD Mon YYYY HH:MM

Examples:
- "05 Dec 2024 19:30"
- "18 Jan 2025 14:00"

If you cannot determine the date/time from a message, respond with:
MESSAGE_NUMBER: unknown

IMPORTANT:
- Always use 24-hour time format (e.g., 14:00, not 2:00 PM)
- Use 3-letter month abbreviations (Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
- Always include leading zeros for days and hours (05, not 5)
- Parse relative dates like "сегодня/today" using the current date
- Parse "завтра/tomorrow" as current date + 1 day
- For partial times like "18" assume "18:00"
- Always ensure the event date is in the future relative to message timestamp`;
  }

  // Set default event description prompt
  if (!config.eventDescriptionPrompt) {
    config.eventDescriptionPrompt = `Convert these event messages into structured event information. Respond in English.

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
DESCRIPTION: Join us for our monthly JavaScript meetup where we discuss latest trends, share projects, and network with fellow developers.`;
  }

  // Validate required fields
  if (!config.groupsToParse || !config.channelsToParse || !config.userInterests || !config.weeklyTimeslots) {
    console.error('Missing required configuration fields:');
    console.error('Required: groupsToParse, channelsToParse, userInterests, weeklyTimeslots');
    process.exit(1);
  }

  // Log final configuration
  const finalConfig = config as Config;
  console.log('Configuration loaded successfully:');
  console.log(`  groupsToParse: ${finalConfig.groupsToParse.length} specified`);
  console.log(`  channelsToParse: ${finalConfig.channelsToParse.length} specified`);
  console.log(`  userInterests: ${finalConfig.userInterests.length} specified`);
  console.log(`  weeklyTimeslots: ${finalConfig.weeklyTimeslots.length} specified`);
  console.log(`  maxGroupMessages: ${finalConfig.maxGroupMessages}${!providedMaxGroupMessages && !config.maxInputMessages ? ' (default)' : ''}`);
  console.log(`  maxChannelMessages: ${finalConfig.maxChannelMessages}${!providedMaxChannelMessages && !config.maxInputMessages ? ' (default)' : ''}`);
  console.log(`  skipOnlineEvents: ${finalConfig.skipOnlineEvents}${!providedSkipOnlineEvents ? ' (default)' : ''}`);
  console.log(`  writeDebugFiles: ${finalConfig.writeDebugFiles}${!providedWriteDebugFiles ? ' (default)' : ''}`);
  console.log(`  verboseLogging: ${finalConfig.verboseLogging}${!providedVerboseLogging ? ' (default)' : ''}`);
  console.log(`  gptBatchSizeEventDetection: ${finalConfig.gptBatchSizeEventDetection}${!providedGptBatchSizeEventDetection ? ' (default)' : ''}`);
  console.log(`  gptBatchSizeEventClassification: ${finalConfig.gptBatchSizeEventClassification}${!providedGptBatchSizeEventClassification ? ' (default)' : ''}`);
  console.log(`  gptBatchSizeScheduleExtraction: ${finalConfig.gptBatchSizeScheduleExtraction}${!providedGptBatchSizeScheduleExtraction ? ' (default)' : ''}`);
  console.log(`  gptBatchSizeEventDescription: ${finalConfig.gptBatchSizeEventDescription}${!providedGptBatchSizeEventDescription ? ' (default)' : ''}`);
  console.log(`  lastGenerationTimestamp: ${finalConfig.lastGenerationTimestamp || 'not set'}`);
  console.log(`  eventMessageCues: ${Object.values(finalConfig.eventMessageCues).flat().length} cues${!providedEventMessageCues ? ' (default)' : ''}`);
  console.log(`  eventDetectionPrompt: ${finalConfig.eventDetectionPrompt!.length} chars${!providedEventDetectionPrompt ? ' (default)' : ''}`);
  console.log(`  interestMatchingPrompt: ${finalConfig.interestMatchingPrompt!.length} chars${!providedInterestMatchingPrompt ? ' (default)' : ''}`);
  console.log(`  eventTypeClassificationPrompt: ${finalConfig.eventTypeClassificationPrompt!.length} chars${!providedEventTypeClassificationPrompt ? ' (default)' : ''}`);
  console.log(`  scheduleExtractionPrompt: ${finalConfig.scheduleExtractionPrompt!.length} chars${!providedScheduleExtractionPrompt ? ' (default)' : ''}`);
  console.log(`  eventDescriptionPrompt: ${finalConfig.eventDescriptionPrompt!.length} chars${!providedEventDescriptionPrompt ? ' (default)' : ''}`);
  console.log('');

  return finalConfig;
}