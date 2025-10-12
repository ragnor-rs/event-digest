import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TelegramMessage, EventDescription } from '../domain/entities';

export class Cache {
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
    telegram_messages: Record<string, TelegramMessage[]>; // source name -> telegram messages (step 1)
    messages: Record<string, boolean>; // message link -> is event (step 3)
    event_type_classification: Record<string, 'offline' | 'online' | 'hybrid'>; // message link -> event type (step 4)
    matching_interests: Record<string, string[]>; // message link -> matched interests (step 6)
    scheduled_events: Record<string, string>; // message link -> extracted datetime (step 5)
    events: Record<string, EventDescription>; // message link -> event description object (step 7)
  };

  constructor() {
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
    telegram_messages: Record<string, TelegramMessage[]>;
    messages: Record<string, boolean>;
    event_type_classification: Record<string, 'offline' | 'online' | 'hybrid'>;
    matching_interests: Record<string, string[]>;
    scheduled_events: Record<string, string>;
    events: Record<string, EventDescription>;
  } {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch {
      console.log('  Failed to create cache directory, starting fresh');
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
    } catch {
      console.log(`  Cache file ${storeName}.json not found or corrupted, starting fresh`);
    }
    return defaultValue;
  }

  private saveCacheFile(storeName: keyof typeof this.cacheFiles): void {
    try {
      const filePath = this.cacheFiles[storeName];
      fs.writeFileSync(filePath, JSON.stringify(this.cache[storeName], null, 2));
    } catch (error) {
      console.error(`Failed to save ${storeName} cache:`, error);
      throw new Error(`Cache save failed for ${storeName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Public method to manually save cache when batching updates
  public save(): void {
    this.saveCacheFile('telegram_messages');
    this.saveCacheFile('messages');
    this.saveCacheFile('event_type_classification');
    this.saveCacheFile('matching_interests');
    this.saveCacheFile('scheduled_events');
    this.saveCacheFile('events');
  }

  // Telegram messages caching (step 1)
  getCachedMessages(sourceName: string): TelegramMessage[] | undefined {
    return this.cache.telegram_messages[sourceName];
  }

  cacheMessages(sourceName: string, messages: TelegramMessage[], autoSave: boolean = true): void {
    this.cache.telegram_messages[sourceName] = messages;
    if (autoSave) {
      this.saveCacheFile('telegram_messages');
    }
  }

  getLastMessageTimestamp(sourceName: string): string | undefined {
    const cachedMessages = this.getCachedMessages(sourceName);
    if (!cachedMessages || cachedMessages.length === 0) {
      return undefined;
    }
    // Messages are assumed to be sorted by timestamp, return the last one
    return cachedMessages[cachedMessages.length - 1].timestamp;
  }

  // Event message detection (step 3)
  isEventMessageCached(messageLink: string): boolean | undefined {
    return this.cache.messages[messageLink];
  }

  cacheEventMessage(messageLink: string, isEvent: boolean, autoSave: boolean = true): void {
    this.cache.messages[messageLink] = isEvent;
    if (autoSave) {
      this.saveCacheFile('messages');
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
      this.saveCacheFile('matching_interests');
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
      this.saveCacheFile('scheduled_events');
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
      this.saveCacheFile('events');
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

  // Clear all cache entries (useful for testing or forcing fresh data)
  clearAllEntries(): void {
    this.cache = {
      telegram_messages: {},
      messages: {},
      event_type_classification: {},
      matching_interests: {},
      scheduled_events: {},
      events: {},
    };
    this.save();
    console.log('  All cache entries cleared');
  }

  // Event type classification (step 4)
  getEventTypeCache(messageLink: string): 'offline' | 'online' | 'hybrid' | undefined {
    return this.cache.event_type_classification[messageLink];
  }

  cacheEventType(messageLink: string, eventType: 'offline' | 'online' | 'hybrid', autoSave: boolean = true): void {
    this.cache.event_type_classification[messageLink] = eventType;
    if (autoSave) {
      this.saveCacheFile('event_type_classification');
    }
  }

  // Clear event announcements cache specifically
  clearAnnouncementsCache(): void {
    this.cache.event_type_classification = {};
    this.saveCacheFile('event_type_classification');
    console.log('  Event announcements cache cleared');
  }

  // Clear matching interests cache specifically
  clearInterestingAnnouncementsCache(): void {
    this.cache.matching_interests = {};
    this.saveCacheFile('matching_interests');
    console.log('  Matching interests cache cleared');
  }

  // Create hash for preferences (interests/timeslots) for shorter cache keys
  private hashPreferences(preferences: string): string {
    return crypto.createHash('sha256').update(preferences).digest('hex').substring(0, 16);
  }
}
