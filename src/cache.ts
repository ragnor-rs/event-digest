import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface CacheEntry {
  result: any;
  timestamp: number;
}

interface CacheStore {
  step3_events: Record<string, boolean>; // message link -> is event
  step4_interests: Record<string, string[]>; // message link -> matched interests
  step5_schedule: Record<string, string>; // message link -> extracted datetime
  step6_events: Record<string, any>; // message link -> event object
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
      step3_events: {},
      step4_interests: {},
      step5_schedule: {},
      step6_events: {}
    };
  }

  private saveCache(): void {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error('Failed to save cache:', error);
    }
  }

  // Step 3: Event announcement filtering
  getEventResult(messageLink: string): boolean | null {
    return this.cache.step3_events[messageLink] ?? null;
  }

  setEventResult(messageLink: string, isEvent: boolean): void {
    this.cache.step3_events[messageLink] = isEvent;
    this.saveCache();
  }

  // Step 4: Interest matching
  getInterestResult(messageLink: string, userInterests: string[]): string[] | null {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.step4_interests[cacheKey] ?? null;
  }

  setInterestResult(messageLink: string, interests: string[], userInterests: string[]): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.step4_interests[cacheKey] = interests;
    this.saveCache();
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

  // Step 5: Schedule filtering (datetime extraction)
  getScheduleResult(messageLink: string, weeklyTimeslots: string[]): string | null {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    return this.cache.step5_schedule[cacheKey] ?? null;
  }

  setScheduleResult(messageLink: string, datetime: string, weeklyTimeslots: string[]): void {
    const cacheKey = this.createScheduleCacheKey(messageLink, weeklyTimeslots);
    this.cache.step5_schedule[cacheKey] = datetime;
    this.saveCache();
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

  // Step 6: Event conversion
  getEventConversion(messageLink: string, userInterests: string[]): any | null {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    return this.cache.step6_events[cacheKey] ?? null;
  }

  setEventConversion(messageLink: string, event: any, userInterests: string[]): void {
    const cacheKey = this.createInterestCacheKey(messageLink, userInterests);
    this.cache.step6_events[cacheKey] = event;
    this.saveCache();
  }

  // Cache statistics
  getStats(): {
    step3_cached: number;
    step4_cached: number;
    step5_cached: number;
    step6_cached: number;
    total_cached: number;
  } {
    return {
      step3_cached: Object.keys(this.cache.step3_events).length,
      step4_cached: Object.keys(this.cache.step4_interests).length,
      step5_cached: Object.keys(this.cache.step5_schedule).length,
      step6_cached: Object.keys(this.cache.step6_events).length,
      total_cached: Object.keys(this.cache.step3_events).length + 
                   Object.keys(this.cache.step4_interests).length +
                   Object.keys(this.cache.step5_schedule).length +
                   Object.keys(this.cache.step6_events).length
    };
  }

  // Clear old cache entries (optional cleanup)
  clearOldEntries(daysOld: number = 30): void {
    const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    
    // For simplicity, we're just clearing all cache for now
    // In a more sophisticated implementation, we'd track timestamps per entry
    if (Date.now() > cutoffTime) {
      this.cache = {
        step3_events: {},
        step4_interests: {},
        step5_schedule: {},
        step6_events: {}
      };
      this.saveCache();
      console.log('  Cache cleared (older than 30 days)');
    }
  }

  // Clear step 4 cache specifically
  clearStep4Cache(): void {
    this.cache.step4_interests = {};
    this.saveCache();
    console.log('  Step 4 cache cleared');
  }

  // Create hash for preferences (interests/timeslots) for shorter cache keys
  private hashPreferences(preferences: string): string {
    return crypto.createHash('sha256').update(preferences).digest('hex').substring(0, 16);
  }
}