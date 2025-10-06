export interface TelegramMessage {
  timestamp: string;
  content: string;
  link: string;
}

export interface EventAnnouncement {
  message: TelegramMessage;
  event_type: 'offline' | 'online' | 'hybrid';
}

export interface InterestingAnnouncement {
  announcement: EventAnnouncement;
  interests_matched: string[];
}

export interface ScheduledEvent {
  interesting_announcement: InterestingAnnouncement;
  start_datetime: string;
}

export interface EventDescription {
  date_time: string;
  met_interests: string[];
  title: string;
  short_summary: string;
  link: string;
}

export interface Event {
  event_description: EventDescription;
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
  eventDetectionPrompt?: string;
  interestMatchingPrompt?: string;
  eventTypeClassificationPrompt?: string;
}