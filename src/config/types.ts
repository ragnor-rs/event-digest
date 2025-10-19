export interface Config {
  groupsToParse: string[];
  channelsToParse: string[];
  maxInputMessages?: number; // Legacy support
  maxGroupMessages: number;
  maxChannelMessages: number;
  userInterests: string[];
  weeklyTimeslots: string[];
  eventMessageCues: Record<string, string[]>;
  skipOnlineEvents: boolean;
  writeDebugFiles: boolean;
  verboseLogging: boolean;
  minEventDetectionConfidence: number; // Minimum confidence threshold for event detection (0.0-1.0)
  minEventClassificationConfidence: number; // Minimum confidence threshold for event type classification (0.0-1.0)
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
  sendEventsRecipient?: string; // Recipient account for sending events (e.g., @username or chat ID)
  sendEventsBatchSize: number; // Number of events to send per message batch
}
