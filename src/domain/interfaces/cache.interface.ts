import { TelegramMessage, EventDescription, EventType } from '../entities';

/**
 * Interface for cache operations
 * This allows domain services to remain independent of specific cache implementations
 */
export interface ICache {
  /**
   * Save all cache stores to persistent storage
   */
  save(): void;

  // Telegram messages caching (step 1)
  getCachedMessages(sourceName: string): TelegramMessage[] | undefined;
  cacheMessages(sourceName: string, messages: TelegramMessage[], autoSave?: boolean): void;
  getLastMessageTimestamp(sourceName: string): string | undefined;

  // Event message detection (step 3)
  isEventMessageCached(messageLink: string): boolean | undefined;
  cacheEventMessage(messageLink: string, isEvent: boolean, autoSave?: boolean): void;

  // Event type classification (step 4)
  getEventTypeCache(messageLink: string): EventType | undefined;
  cacheEventType(messageLink: string, eventType: EventType, autoSave?: boolean): void;

  // Schedule filtering (step 5)
  getScheduledEventCache(messageLink: string, weeklyTimeslots: string[]): string | undefined;
  cacheScheduledEvent(messageLink: string, datetime: string, weeklyTimeslots: string[], autoSave?: boolean): void;

  // Interest matching (step 6)
  getMatchingInterestsCache(messageLink: string, userInterests: string[]): string[] | undefined;
  cacheMatchingInterests(
    messageLink: string,
    interests: string[],
    userInterests: string[],
    autoSave?: boolean
  ): void;

  // Event conversion (step 7)
  getConvertedEventCache(messageLink: string, userInterests: string[]): EventDescription | undefined;
  cacheConvertedEvent(messageLink: string, event: EventDescription, userInterests: string[], autoSave?: boolean): void;

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
