import { ReasoningEffort } from '../domain/interfaces';

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
  // Keep events whose date is known but whose time is not ("27 Sep 2026 unknown").
  // They cannot be matched against weeklyTimeslots, so enabling this admits events
  // that may fall outside your availability.
  includeEventsWithoutTime: boolean;
  // Collapse the same event announced by several sources into one entry.
  deduplicateEvents: boolean;
  minEventDetectionConfidence: number; // Minimum confidence threshold for event detection (0.0-1.0)
  minEventClassificationConfidence: number; // Minimum confidence threshold for event type classification (0.0-1.0)
  minInterestConfidence: number; // Minimum confidence threshold for interest matching (0.0-1.0)
  eventDetectionBatchSize: number;
  eventClassificationBatchSize: number;
  scheduleExtractionBatchSize: number;
  eventDescriptionBatchSize: number;
  reasoningEffort: ReasoningEffort; // Default reasoning effort for every GPT step
  // Per-step overrides; each falls back to reasoningEffort when unset
  eventDetectionReasoningEffort?: ReasoningEffort;
  eventClassificationReasoningEffort?: ReasoningEffort;
  scheduleExtractionReasoningEffort?: ReasoningEffort;
  interestMatchingReasoningEffort?: ReasoningEffort;
  eventDescriptionReasoningEffort?: ReasoningEffort;
  eventDetectionPrompt?: string;
  interestMatchingPrompt?: string;
  eventTypeClassificationPrompt?: string;
  scheduleExtractionPrompt?: string;
  eventDescriptionPrompt?: string;
  sendEventsRecipient?: string; // Recipient account for sending events (e.g., @username or chat ID)
  sendEventsBatchSize: number; // Number of events to send per message batch
}
