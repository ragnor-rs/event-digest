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
  isEventMessageCached(messageLink: string): boolean | undefined;
  cacheEventMessage(messageLink: string, isEvent: boolean, autoSave?: boolean): void;

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
