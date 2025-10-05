import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface CacheEntry {
  result: any;
  timestamp: number;
}

interface CacheStore {
  messages: Record<string, boolean>; // message link -> is event (step 3)
  detected_hybrid_event_announcements: Record<string, boolean>; // message link -> is hybrid event (step 4.1) [DEPRECATED]
  detected_offline_event_announcements: Record<string, boolean>; // message link -> is offline event (step 4.2) [DEPRECATED]
  event_type_classification: Record<string, 'offline' | 'online' | 'hybrid'>; // message link -> event type (step 4)
  matching_interests: Record<string, string[]>; // message link -> matched interests (step 5)
  scheduled_events: Record<string, string>; // message link -> extracted datetime (step 6)
  events: Record<string, any>; // message link -> event object (step 7)
}

export class Cache {
  private cacheDir: string;
  private cacheFile: string;
  private cache: CacheStore;

  constructor() {
    this.cacheDir = path.join(process.cwd(), '.cache');
    this.cacheFile = path.join(this.cacheDir, 'gpt-results.json');
    this.cache = this.loadCache();
  }

  private loadCache(): CacheStore {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.log('  Cache file not found or corrupted, starting fresh');
    }

    return {
      messages: {},
      detected_hybrid_event_announcements: {},
      detected_offline_event_announcements: {},
      event_type_classification: {},
      matching_interests: {},
      scheduled_events: {},
      events: {}
    };
  }

  private saveCache(): void {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error('Failed to save cache:', error);
    }
  }

  // Public method to manually save cache when batching updates
  public save(): void {
    this.saveCache();
  }

  // Event message detection (step 3)
  isEventMessageCached(messageLink: string): boolean | null {
    return this.cache.messages[messageLink] ?? null;
  }

  cacheEventMessage(messageLink: string, isEvent: boolean, autoSave: boolean = true): void {
    this.cache.messages[messageLink] = isEvent;
    if (autoSave) {
      this.saveCache();
    }
  }


  // Interest matching (step 5)
  getMatchingInterestsCache(messageLink: string, userInterests: string[]): string[] | null {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.matching_interests[cacheKey] ?? null;
  }

  cacheMatchingInterests(messageLink: string, interests: string[], userInterests: string[], autoSave: boolean = true): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.matching_interests[cacheKey] = interests;
    if (autoSave) {
      this.saveCache();
    }
  }

  private createInterestCacheKey(messageLink: string, userInterests: string[]): string {
    // Normalize interests: lowercase and sort alphabetically
    const normalizedInterests = userInterests
      .map(interest => interest.toLowerCase().trim())
      .sort()
      .join(',');
    
    // Hash the normalized interests for shorter, consistent cache keys
    const preferencesHash = this.hashPreferences(normalizedInterests);
    return `${messageLink}|interests:${preferencesHash}`;
  }

  // Schedule filtering (datetime extraction) (step 6)
  getScheduledEventCache(messageLink: string, weeklyTimeslots: string[]): string | null {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    return this.cache.scheduled_events[cacheKey] ?? null;
  }

  cacheScheduledEvent(messageLink: string, datetime: string, weeklyTimeslots: string[], autoSave: boolean = true): void {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    this.cache.scheduled_events[cacheKey] = datetime;
    if (autoSave) {
      this.saveCache();
    }
  }

  private createScheduleCacheKey(messageLink: string, weeklyTimeslots: string[]): string {
    // Normalize timeslots: sort alphabetically for consistent cache keys
    const normalizedTimeslots = weeklyTimeslots
      .map(slot => slot.trim())
      .sort()
      .join(',');
    
    // Hash the normalized timeslots for shorter, consistent cache keys
    const preferencesHash = this.hashPreferences(normalizedTimeslots);
    return `${messageLink}|schedule:${preferencesHash}`;
  }

  // Event conversion (step 7)
  getConvertedEventCache(messageLink: string, userInterests: string[]): any | null {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.events[cacheKey] ?? null;
  }

  cacheConvertedEvent(messageLink: string, event: any, userInterests: string[], autoSave: boolean = true): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.events[cacheKey] = event;
    if (autoSave) {
      this.saveCache();
    }
  }

  // Cache statistics
  getStats(): {
    messages_cached: number;
    event_type_classification_cached: number;
    matching_interests_cached: number;
    scheduled_events_cached: number;
    events_cached: number;
    total_cached: number;
  } {
    return {
      messages_cached: Object.keys(this.cache.messages).length,
      event_type_classification_cached: Object.keys(this.cache.event_type_classification).length,
      matching_interests_cached: Object.keys(this.cache.matching_interests).length,
      scheduled_events_cached: Object.keys(this.cache.scheduled_events).length,
      events_cached: Object.keys(this.cache.events).length,
      total_cached: Object.keys(this.cache.messages).length +
                   Object.keys(this.cache.event_type_classification).length +
                   Object.keys(this.cache.matching_interests).length +
                   Object.keys(this.cache.scheduled_events).length +
                   Object.keys(this.cache.events).length
    };
  }

  // Clear old cache entries (optional cleanup)
  clearOldEntries(daysOld: number = 30): void {
    const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    
    // For simplicity, we're just clearing all cache for now
    // In a more sophisticated implementation, we'd track timestamps per entry
    if (Date.now() > cutoffTime) {
      this.cache = {
        messages: {},
        detected_hybrid_event_announcements: {},
        detected_offline_event_announcements: {},
        event_type_classification: {},
        matching_interests: {},
        scheduled_events: {},
        events: {}
      };
      this.saveCache();
      console.log('  Cache cleared (older than 30 days)');
    }
  }

  // Hybrid event announcement detection (step 4.1)
  isHybridEventCached(messageLink: string): boolean | null {
    return this.cache.detected_hybrid_event_announcements[messageLink] ?? null;
  }

  cacheHybridEvent(messageLink: string, isHybrid: boolean, autoSave: boolean = true): void {
    this.cache.detected_hybrid_event_announcements[messageLink] = isHybrid;
    if (autoSave) {
      this.saveCache();
    }
  }

  // Offline event announcement detection (step 4.2)
  isOfflineEventCached(messageLink: string): boolean | null {
    return this.cache.detected_offline_event_announcements[messageLink] ?? null;
  }

  cacheOfflineEvent(messageLink: string, isOffline: boolean, autoSave: boolean = true): void {
    this.cache.detected_offline_event_announcements[messageLink] = isOffline;
    if (autoSave) {
      this.saveCache();
    }
  }

  // Event type classification (step 4) - new unified approach
  getEventTypeCache(messageLink: string): 'offline' | 'online' | 'hybrid' | null {
    return this.cache.event_type_classification[messageLink] ?? null;
  }

  cacheEventType(messageLink: string, eventType: 'offline' | 'online' | 'hybrid', autoSave: boolean = true): void {
    this.cache.event_type_classification[messageLink] = eventType;
    if (autoSave) {
      this.saveCache();
    }
  }

  // Clear event announcements cache specifically
  clearAnnouncementsCache(): void {
    this.cache.detected_hybrid_event_announcements = {};
    this.cache.detected_offline_event_announcements = {};
    this.cache.event_type_classification = {};
    this.saveCache();
    console.log('  Event announcements cache cleared');
  }

  // Clear matching interests cache specifically
  clearInterestingAnnouncementsCache(): void {
    this.cache.matching_interests = {};
    this.saveCache();
    console.log('  Matching interests cache cleared');
  }

  // Create hash for preferences (interests/timeslots) for shorter cache keys
  private hashPreferences(preferences: string): string {
    return crypto.createHash('sha256').update(preferences).digest('hex').substring(0, 16);
  }
}