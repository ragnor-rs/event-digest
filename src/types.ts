export interface TelegramMessage {
  timestamp: string;
  content: string;
  link: string;
}

export interface EventDescription {
  date_time: string;
  met_interests: string[];
  title: string;
  short_summary: string;
  link: string;
}

export interface Event {
  message: TelegramMessage;
  event_type?: 'offline' | 'online' | 'hybrid';
  interests_matched?: string[];
  start_datetime?: string;
  event_description?: EventDescription;
}

export interface Config {
  groupsToParse: string[];
  channelsToParse: string[];
  lastGenerationTimestamp?: string;
  maxInputMessages?: number; // Legacy support
  maxGroupMessages: number;
  maxChannelMessages: number;
  userInterests: string[];
  weeklyTimeslots: string[];
  eventMessageCues: Record<string, string[]>;
  skipOnlineEvents: boolean;
  writeDebugFiles: boolean;
  verboseLogging: boolean;
  gptBatchSizeEventDetection: number;
  gptBatchSizeEventClassification: number;
  gptBatchSizeScheduleExtraction: number;
  gptBatchSizeEventDescription: number;
  eventDetectionPrompt?: string;
  interestMatchingPrompt?: string;
  eventTypeClassificationPrompt?: string;
  scheduleExtractionPrompt?: string;
  eventDescriptionPrompt?: string;
}