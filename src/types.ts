export interface TelegramMessage {
  timestamp: string;
  content: string;
  link: string;
}

export interface InterestingMessage {
  message: TelegramMessage;
  interests_matched: string[];
}

export interface ScheduledMessage {
  interesting_message: InterestingMessage;
  start_datetime: string;
}

export interface Event {
  date_time: string;
  met_interests: string[];
  title: string;
  short_summary: string;
  full_description: string;
  link: string;
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
}