import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ICache } from '../domain/interfaces';
import { SourceMessage, EventDescription, EventType } from '../domain/entities';
import { Logger } from '../shared/logger';

export class Cache implements ICache {
  private logger: Logger;
  private cacheDir: string;
  private cacheFiles: {
    telegram_messages: string;
    messages: string;
    event_type_classification: string;
    matching_interests: string;
    scheduled_events: string;
    events: string;
  };
  private cache: {
    telegram_messages: Record<string, SourceMessage[]>; // source name -> source messages (step 1)
    messages: Record<string, boolean>; // message link -> is event (step 3)
    event_type_classification: Record<string, EventType>; // message link -> event type (step 4)
    matching_interests: Record<string, string[]>; // message link -> matched interests (step 6)
    scheduled_events: Record<string, string>; // message link -> extracted datetime (step 5)
    events: Record<string, EventDescription>; // message link -> event description object (step 7)
  };

  constructor(logger: Logger) {
    this.logger = logger;
    this.cacheDir = path.join(process.cwd(), '.cache');
    this.cacheFiles = {
      telegram_messages: path.join(this.cacheDir, 'telegram_messages.json'),
      messages: path.join(this.cacheDir, 'messages.json'),
      event_type_classification: path.join(this.cacheDir, 'event_type_classification.json'),
      matching_interests: path.join(this.cacheDir, 'matching_interests.json'),
      scheduled_events: path.join(this.cacheDir, 'scheduled_events.json'),
      events: path.join(this.cacheDir, 'events.json'),
    };
    this.cache = this.loadCache();
  }

  private loadCache(): {
    telegram_messages: Record<string, SourceMessage[]>;
    messages: Record<string, boolean>;
    event_type_classification: Record<string, EventType>;
    matching_interests: Record<string, string[]>;
    scheduled_events: Record<string, string>;
    events: Record<string, EventDescription>;
  } {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (error) {
      this.logger.error('Failed to create cache directory, starting with in-memory cache only', error);
    }

    return {
      telegram_messages: this.loadCacheFile('telegram_messages', {}),
      messages: this.loadCacheFile('messages', {}),
      event_type_classification: this.loadCacheFile('event_type_classification', {}),
      matching_interests: this.loadCacheFile('matching_interests', {}),
      scheduled_events: this.loadCacheFile('scheduled_events', {}),
      events: this.loadCacheFile('events', {}),
    };
  }

  private loadCacheFile<T>(storeName: keyof typeof this.cacheFiles, defaultValue: T): T {
    try {
      const filePath = this.cacheFiles[storeName];
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      this.logger.error(`Failed to load cache file ${storeName}.json (starting fresh)`, error);
    }
    return defaultValue;
  }

  private saveCacheFile(storeName: keyof typeof this.cacheFiles): void {
    const filePath = this.cacheFiles[storeName];
    const tempFilePath = filePath + '.tmp';

    try {
      // Write to temporary file first
      fs.writeFileSync(tempFilePath, JSON.stringify(this.cache[storeName], null, 2));

      // Atomic rename (overwrites destination if it exists)
      fs.renameSync(tempFilePath, filePath);
    } catch (error) {
      // Clean up temp file if it exists
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (cleanupError) {
        // Log cleanup errors for diagnostics but don't fail
        this.logger.error(`Failed to clean up temp file ${tempFilePath}`, cleanupError);
      }

      this.logger.error(`Failed to save ${storeName} cache`, error);
      throw new Error(`Cache save failed for ${storeName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Public method to manually save cache when batching updates
  public save(): void {
    const stores: Array<keyof typeof this.cacheFiles> = [
      'telegram_messages',
      'messages',
      'event_type_classification',
      'matching_interests',
      'scheduled_events',
      'events',
    ];
    const errors: string[] = [];

    for (const store of stores) {
      try {
        this.saveCacheFile(store);
      } catch (error) {
        errors.push(`${store}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      this.logger.error('Some cache stores failed to save:', errors.join('; '));
      throw new Error(`Cache save failed for ${errors.length} store(s): ${errors.join('; ')}`);
    }
  }

  // Telegram messages caching (step 1)
  getCachedMessages(sourceName: string): SourceMessage[] | undefined {
    return this.cache.telegram_messages[sourceName];
  }

  cacheMessages(sourceName: string, messages: SourceMessage[], autoSave: boolean = true): void {
    this.cache.telegram_messages[sourceName] = messages;
    if (autoSave) {
      try {
        this.saveCacheFile('telegram_messages');
      } catch (error) {
        // Error already logged in saveCacheFile, re-throw to notify caller
        throw error;
      }
    }
  }

  getLastMessageTimestamp(sourceName: string): string | undefined {
    const cachedMessages = this.getCachedMessages(sourceName);
    if (!cachedMessages || cachedMessages.length === 0) {
      return undefined;
    }
    // Messages are assumed to be sorted by timestamp, return the last one
    const lastMessage = cachedMessages[cachedMessages.length - 1];
    return lastMessage?.timestamp;
  }

  // Event message detection (step 3)
  isEventMessageCached(messageLink: string): boolean | undefined {
    return this.cache.messages[messageLink];
  }

  cacheEventMessage(messageLink: string, isEvent: boolean, autoSave: boolean = true): void {
    this.cache.messages[messageLink] = isEvent;
    if (autoSave) {
      try {
        this.saveCacheFile('messages');
      } catch (error) {
        // Error already logged in saveCacheFile, re-throw to notify caller
        throw error;
      }
    }
  }

  // Interest matching (step 6)
  getMatchingInterestsCache(messageLink: string, userInterests: string[]): string[] | undefined {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.matching_interests[cacheKey];
  }

  cacheMatchingInterests(
    messageLink: string,
    interests: string[],
    userInterests: string[],
    autoSave: boolean = true
  ): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.matching_interests[cacheKey] = interests;
    if (autoSave) {
      try {
        this.saveCacheFile('matching_interests');
      } catch (error) {
        // Error already logged in saveCacheFile, re-throw to notify caller
        throw error;
      }
    }
  }

  private createInterestCacheKey(messageLink: string, userInterests: string[]): string {
    // Normalize interests: lowercase and sort alphabetically
    const normalizedInterests = userInterests
      .map((interest) => interest.toLowerCase().trim())
      .sort()
      .join(',');

    // Hash the normalized interests for shorter, consistent cache keys
    const preferencesHash = this.hashPreferences(normalizedInterests);
    return `${messageLink}|interests:${preferencesHash}`;
  }

  // Schedule filtering (datetime extraction) (step 5)
  getScheduledEventCache(messageLink: string, weeklyTimeslots: string[]): string | undefined {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    return this.cache.scheduled_events[cacheKey];
  }

  cacheScheduledEvent(
    messageLink: string,
    datetime: string,
    weeklyTimeslots: string[],
    autoSave: boolean = true
  ): void {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    this.cache.scheduled_events[cacheKey] = datetime;
    if (autoSave) {
      try {
        this.saveCacheFile('scheduled_events');
      } catch (error) {
        // Error already logged in saveCacheFile, re-throw to notify caller
        throw error;
      }
    }
  }

  private createScheduleCacheKey(messageLink: string, weeklyTimeslots: string[]): string {
    // Normalize timeslots: sort alphabetically for consistent cache keys
    const normalizedTimeslots = weeklyTimeslots
      .map((slot) => slot.trim())
      .sort()
      .join(',');

    // Hash the normalized timeslots for shorter, consistent cache keys
    const preferencesHash = this.hashPreferences(normalizedTimeslots);
    return `${messageLink}|schedule:${preferencesHash}`;
  }

  // Event conversion (step 7)
  getConvertedEventCache(messageLink: string, userInterests: string[]): EventDescription | undefined {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.events[cacheKey];
  }

  cacheConvertedEvent(
    messageLink: string,
    event: EventDescription,
    userInterests: string[],
    autoSave: boolean = true
  ): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.events[cacheKey] = event;
    if (autoSave) {
      try {
        this.saveCacheFile('events');
      } catch (error) {
        // Error already logged in saveCacheFile, re-throw to notify caller
        throw error;
      }
    }
  }

  // Cache statistics
  getStats(): {
    telegram_messages_cached: number;
    messages_cached: number;
    event_type_classification_cached: number;
    matching_interests_cached: number;
    scheduled_events_cached: number;
    events_cached: number;
    total_cached: number;
  } {
    const telegramMessagesCount = Object.values(this.cache.telegram_messages).reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );
    return {
      telegram_messages_cached: telegramMessagesCount,
      messages_cached: Object.keys(this.cache.messages).length,
      event_type_classification_cached: Object.keys(this.cache.event_type_classification).length,
      matching_interests_cached: Object.keys(this.cache.matching_interests).length,
      scheduled_events_cached: Object.keys(this.cache.scheduled_events).length,
      events_cached: Object.keys(this.cache.events).length,
      total_cached:
        telegramMessagesCount +
        Object.keys(this.cache.messages).length +
        Object.keys(this.cache.event_type_classification).length +
        Object.keys(this.cache.matching_interests).length +
        Object.keys(this.cache.scheduled_events).length +
        Object.keys(this.cache.events).length,
    };
  }

  // Event type classification (step 4)
  getEventTypeCache(messageLink: string): EventType | undefined {
    return this.cache.event_type_classification[messageLink];
  }

  cacheEventType(messageLink: string, eventType: EventType, autoSave: boolean = true): void {
    this.cache.event_type_classification[messageLink] = eventType;
    if (autoSave) {
      try {
        this.saveCacheFile('event_type_classification');
      } catch (error) {
        // Error already logged in saveCacheFile, re-throw to notify caller
        throw error;
      }
    }
  }

  // Create hash for preferences (interests/timeslots) for shorter cache keys
  private hashPreferences(preferences: string): string {
    return crypto.createHash('sha256').update(preferences).digest('hex').substring(0, 16);
  }
}
