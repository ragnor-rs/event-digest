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
  minInterestConfidence: number; // Minimum confidence threshold for interest matching (0.0-1.0)
  eventDetectionBatchSize: number;
  eventClassificationBatchSize: number;
  scheduleExtractionBatchSize: number;
  eventDescriptionBatchSize: number;
  eventDetectionPrompt?: string;
  interestMatchingPrompt?: string;
  eventTypeClassificationPrompt?: string;
  scheduleExtractionPrompt?: string;
  eventDescriptionPrompt?: string;
}
