import * as fs from 'fs';
import * as path from 'path';
import { TelegramMessage, EventAnnouncement, InterestingAnnouncement } from './types';

export interface DebugStep4Entry {
  message: TelegramMessage;
  gpt_prompt: string;
  gpt_response: string;
  result: 'hybrid' | 'offline' | 'online' | 'discarded';
  substep: '4.1_hybrid' | '4.2_offline' | '4.3_online';
  cached: boolean;
}

export interface DebugStep5Entry {
  announcement: EventAnnouncement;
  gpt_prompt: string;
  gpt_response: string;
  interests_matched: string[];
  result: 'matched' | 'discarded';
  cached: boolean;
}

export interface DebugStep6Entry {
  announcement: InterestingAnnouncement;
  gpt_prompt: string;
  gpt_response: string;
  extracted_datetime: string;
  result: 'scheduled' | 'discarded';
  discard_reason?: string;
  cached: boolean;
}

class DebugWriter {
  private debugDir = 'debug';
  private step4Entries: DebugStep4Entry[] = [];
  private step5Entries: DebugStep5Entry[] = [];
  private step6Entries: DebugStep6Entry[] = [];

  constructor() {
    // Create debug directory if it doesn't exist
    if (!fs.existsSync(this.debugDir)) {
      fs.mkdirSync(this.debugDir, { recursive: true });
    }
  }

  addStep4Entry(entry: DebugStep4Entry): void {
    this.step4Entries.push(entry);
  }

  addStep5Entry(entry: DebugStep5Entry): void {
    this.step5Entries.push(entry);
  }

  addStep6Entry(entry: DebugStep6Entry): void {
    this.step6Entries.push(entry);
  }

  writeAll(): void {
    this.writeStep4();
    this.writeStep5();
    this.writeStep6();
    console.log(`Debug files written to ${this.debugDir}/ directory`);
  }

  private writeStep4(): void {
    const filename = path.join(this.debugDir, 'event_classification.json');
    const data = {
      step: 'Event Type Classification',
      description: 'GPT classification of events as hybrid/offline/online',
      total_entries: this.step4Entries.length,
      substep_counts: {
        hybrid: this.step4Entries.filter(e => e.substep === '4.1_hybrid').length,
        offline: this.step4Entries.filter(e => e.substep === '4.2_offline').length,
        online: this.step4Entries.filter(e => e.substep === '4.3_online').length
      },
      result_counts: {
        hybrid: this.step4Entries.filter(e => e.result === 'hybrid').length,
        offline: this.step4Entries.filter(e => e.result === 'offline').length,
        online: this.step4Entries.filter(e => e.result === 'online').length,
        discarded: this.step4Entries.filter(e => e.result === 'discarded').length
      },
      cache_stats: {
        cached: this.step4Entries.filter(e => e.cached).length,
        uncached: this.step4Entries.filter(e => !e.cached).length
      },
      entries: this.step4Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeStep5(): void {
    const filename = path.join(this.debugDir, 'interest_matching.json');
    const data = {
      step: 'Interest Matching',
      description: 'GPT matching of events to user interests',
      total_entries: this.step5Entries.length,
      result_counts: {
        matched: this.step5Entries.filter(e => e.result === 'matched').length,
        discarded: this.step5Entries.filter(e => e.result === 'discarded').length
      },
      cache_stats: {
        cached: this.step5Entries.filter(e => e.cached).length,
        uncached: this.step5Entries.filter(e => !e.cached).length
      },
      entries: this.step5Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeStep6(): void {
    const filename = path.join(this.debugDir, 'schedule_filtering.json');
    const data = {
      step: 'Schedule Filtering',
      description: 'GPT datetime extraction and schedule matching',
      total_entries: this.step6Entries.length,
      result_counts: {
        scheduled: this.step6Entries.filter(e => e.result === 'scheduled').length,
        discarded: this.step6Entries.filter(e => e.result === 'discarded').length
      },
      discard_reasons: this.getStep6DiscardReasons(),
      cache_stats: {
        cached: this.step6Entries.filter(e => e.cached).length,
        uncached: this.step6Entries.filter(e => !e.cached).length
      },
      entries: this.step6Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private getStep6DiscardReasons(): Record<string, number> {
    const reasons: Record<string, number> = {};
    this.step6Entries
      .filter(e => e.result === 'discarded' && e.discard_reason)
      .forEach(e => {
        const reason = e.discard_reason!;
        reasons[reason] = (reasons[reason] || 0) + 1;
      });
    return reasons;
  }
}

export const debugWriter = new DebugWriter();