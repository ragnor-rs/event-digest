import { SourceMessage, DigestEventDescription, EventTypeClassification, InterestMatch } from '../entities';

/**
 * Interface for cache operations
 * This allows domain services to remain independent of specific cache implementations
 */
/**
 * A step-5 result. `timeKnown` is false when the announcement named a day but
 * no clock time; it has to be cached alongside the date, or a cache hit would
 * silently turn a time-less event back into a timed one.
 */
export interface CachedSchedule {
  datetime: Date;
  timeKnown: boolean;
}

/**
 * A step-3 result: what the model said, before any threshold was applied.
 *
 * Storing the post-threshold boolean instead made minEventDetectionConfidence
 * unadjustable — the decision was frozen at the threshold in force when the
 * message was first seen, and the score that would allow re-judging it was
 * thrown away. Keeping the score lets the threshold be applied on read, so
 * retuning it costs nothing and re-runs no GPT.
 */
export interface CachedEventDetection {
  /** The model's verdict that this is an event announcement at all. */
  isEvent: boolean;
  /** The model's 0.0-1.0 score. Undefined for entries cached before the score was kept. */
  confidence?: number;
}

export interface ICache {
  /**
   * Save all cache stores to persistent storage
   */
  save(): void;

  // Telegram messages caching (step 1)
  getCachedMessages(sourceName: string): SourceMessage[] | undefined;
  cacheMessages(sourceName: string, messages: SourceMessage[], autoSave?: boolean): void;
  getLastMessageTimestamp(sourceName: string): Date | undefined;

  // Event message detection (step 3)
  getEventDetectionCache(messageLink: string): CachedEventDetection | undefined;
  cacheEventDetection(messageLink: string, detection: CachedEventDetection, autoSave?: boolean): void;

  // Event type classification (step 4)
  getEventTypeCache(messageLink: string): EventTypeClassification | undefined;
  cacheEventType(messageLink: string, classification: EventTypeClassification, autoSave?: boolean): void;

  // Schedule filtering (step 5)
  getScheduledEventCache(messageLink: string): CachedSchedule | null | undefined;
  cacheScheduledEvent(messageLink: string, schedule: CachedSchedule | null, autoSave?: boolean): void;

  // Interest matching (step 6)
  getMatchingInterestsCache(messageLink: string, userInterests: string[]): InterestMatch[] | undefined;
  cacheMatchingInterests(
    messageLink: string,
    interests: InterestMatch[],
    userInterests: string[],
    autoSave?: boolean
  ): void;

  // Event conversion (step 7)
  getConvertedEventCache(messageLink: string, userInterests: string[]): DigestEventDescription | undefined;
  cacheConvertedEvent(messageLink: string, event: DigestEventDescription, userInterests: string[], autoSave?: boolean): void;

  // Cache statistics
  getStats(): {
    telegram_messages_cached: number;
    messages_cached: number;
    event_type_classification_cached: number;
    matching_interests_cached: number;
    scheduled_events_cached: number;
    events_cached: number;
    total_cached: number;
  };
}
