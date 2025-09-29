import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface CacheEntry {
  result: any;
  timestamp: number;
}

interface CacheStore {
  event_messages: Record<string, {isEvent: boolean, event_type?: 'offline' | 'online' | 'hybrid'}>; // message link -> event result
  announcements: Record<string, {event_type: 'offline' | 'online' | 'hybrid'}>; // message link -> event type
  interesting_announcements: Record<string, string[]>; // message link -> matched interests
  scheduled_events: Record<string, string>; // message link -> extracted datetime
  events: Record<string, any>; // message link -> event object
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
      event_messages: {},
      announcements: {},
      interesting_announcements: {},
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

  // Event announcement filtering
  getEventResult(messageLink: string): {isEvent: boolean, event_type?: 'offline' | 'online' | 'hybrid'} | null {
    return this.cache.event_messages[messageLink] ?? null;
  }

  setEventResult(messageLink: string, isEvent: boolean, eventType: 'offline' | 'online' | 'hybrid' | undefined, autoSave: boolean = true): void {
    this.cache.event_messages[messageLink] = { isEvent, event_type: eventType };
    if (autoSave) {
      this.saveCache();
    }
  }

  // Convert events to announcements with type classification
  getAnnouncementResult(messageLink: string, offlineEventsOnly: boolean): {event_type: 'offline' | 'online' | 'hybrid'} | null {
    const cacheKey = this.createAnnouncementCacheKey(messageLink, offlineEventsOnly);
    return this.cache.announcements[cacheKey] ?? null;
  }
  setAnnouncementResult(messageLink: string, eventType: 'offline' | 'online' | 'hybrid', offlineEventsOnly: boolean, autoSave: boolean = true): void {
    const cacheKey = this.createAnnouncementCacheKey(messageLink, offlineEventsOnly);
    this.cache.announcements[cacheKey] = { event_type: eventType };
    if (autoSave) {
      this.saveCache();
    }
  }
  private createAnnouncementCacheKey(messageLink: string, offlineEventsOnly: boolean): string {
    return `${messageLink}|offline_only:${offlineEventsOnly}`;
  }

  // Interest matching
  getInterestResult(messageLink: string, userInterests: string[]): string[] | null {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.interesting_announcements[cacheKey] ?? null;
  }

  setInterestResult(messageLink: string, interests: string[], userInterests: string[], autoSave: boolean = true): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.interesting_announcements[cacheKey] = interests;
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

  // Schedule filtering (datetime extraction)
  getScheduleResult(messageLink: string, weeklyTimeslots: string[]): string | null {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    return this.cache.scheduled_events[cacheKey] ?? null;
  }

  setScheduleResult(messageLink: string, datetime: string, weeklyTimeslots: string[], autoSave: boolean = true): void {
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

  // Event conversion
  getEventConversion(messageLink: string, userInterests: string[]): any | null {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.events[cacheKey] ?? null;
  }

  setEventConversion(messageLink: string, event: any, userInterests: string[], autoSave: boolean = true): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.events[cacheKey] = event;
    if (autoSave) {
      this.saveCache();
    }
  }

  // Cache statistics
  getStats(): {
    event_messages_cached: number;
    announcements_cached: number;
    interesting_announcements_cached: number;
    scheduled_events_cached: number;
    events_cached: number;
    total_cached: number;
  } {
    return {
      event_messages_cached: Object.keys(this.cache.event_messages).length,
      announcements_cached: Object.keys(this.cache.announcements).length,
      interesting_announcements_cached: Object.keys(this.cache.interesting_announcements).length,
      scheduled_events_cached: Object.keys(this.cache.scheduled_events).length,
      events_cached: Object.keys(this.cache.events).length,
      total_cached: Object.keys(this.cache.event_messages).length + 
                   Object.keys(this.cache.announcements).length +
                   Object.keys(this.cache.interesting_announcements).length +
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
        event_messages: {},
        announcements: {},
        interesting_announcements: {},
        scheduled_events: {},
        events: {}
      };
      this.saveCache();
      console.log('  Cache cleared (older than 30 days)');
    }
  }

  // Clear step 4 cache specifically
  clearInterestingAnnouncementsCache(): void {
    this.cache.interesting_announcements = {};
    this.saveCache();
    console.log('  Interesting announcements cache cleared');
  }

  // Create hash for preferences (interests/timeslots) for shorter cache keys
  private hashPreferences(preferences: string): string {
    return crypto.createHash('sha256').update(preferences).digest('hex').substring(0, 16);
  }
}