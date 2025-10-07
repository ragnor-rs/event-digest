import * as fs from 'fs';
import * as path from 'path';
import { TelegramMessage, InterestMatch } from './types';

export interface DebugStep3Entry {
  messageLink: string;
  isEvent: boolean;
  cached: boolean;
  prompt?: string;
  gptResponse?: string;
}

export interface DebugStep4Entry {
  message: TelegramMessage;
  gpt_prompt: string;
  gpt_response: string;
  result: 'hybrid' | 'offline' | 'online' | 'discarded';
  substep: '4_classification';
  cached: boolean;
}

export interface DebugStep5Entry {
  message: TelegramMessage;
  event_type: string;
  gpt_prompt: string;
  gpt_response: string;
  extracted_datetime: string;
  result: 'scheduled' | 'discarded';
  discard_reason?: string;
  cached: boolean;
}

export interface DebugStep6Entry {
  message: TelegramMessage;
  event_type: string;
  start_datetime: string;
  gpt_prompt: string;
  gpt_response: string;
  interests_matched: string[];
  interest_matches?: InterestMatch[];  // New: with confidence scores
  result: 'matched' | 'discarded';
  cached: boolean;
}

export interface DebugStep7Entry {
  message: TelegramMessage;
  event_type: string;
  start_datetime: string;
  interests_matched: string[];
  gpt_prompt: string;
  gpt_response: string;
  extracted_title: string;
  extracted_summary: string;
  extraction_success: boolean;
  cached: boolean;
}

class DebugWriter {
  private debugDir = 'debug';
  private step3Entries: DebugStep3Entry[] = [];
  private step4Entries: DebugStep4Entry[] = [];
  private step5Entries: DebugStep5Entry[] = [];
  private step6Entries: DebugStep6Entry[] = [];
  private step7Entries: DebugStep7Entry[] = [];

  constructor() {
    // Create debug directory if it doesn't exist
    if (!fs.existsSync(this.debugDir)) {
      fs.mkdirSync(this.debugDir, { recursive: true });
    }
  }

  writeEventDetection(entries: DebugStep3Entry[]): void {
    this.step3Entries = entries;
    this.writeStep3();
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

  addStep7Entry(entry: DebugStep7Entry): void {
    this.step7Entries.push(entry);
  }

  writeAll(): void {
    this.writeStep4();
    this.writeStep5();
    this.writeStep6();
    this.writeStep7();
    console.log(`Debug files written to ${this.debugDir}/ directory`);
  }

  private writeStep3(): void {
    const filename = path.join(this.debugDir, 'event_detection.json');
    const data = {
      step: 'GPT Event Detection',
      description: 'GPT filtering to identify single event announcements',
      total_entries: this.step3Entries.length,
      result_counts: {
        is_event: this.step3Entries.filter(e => e.isEvent).length,
        not_event: this.step3Entries.filter(e => !e.isEvent).length
      },
      cache_stats: {
        cached: this.step3Entries.filter(e => e.cached).length,
        uncached: this.step3Entries.filter(e => !e.cached).length
      },
      results: this.step3Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeStep4(): void {
    const filename = path.join(this.debugDir, 'event_classification.json');
    const data = {
      step: 'Event Type Classification',
      description: 'Index-based GPT classification of events as offline (0), online (1), or hybrid (2)',
      total_entries: this.step4Entries.length,
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
    const filename = path.join(this.debugDir, 'schedule_filtering.json');
    const data = {
      step: 'Schedule Filtering',
      description: 'GPT datetime extraction and schedule matching',
      total_entries: this.step5Entries.length,
      result_counts: {
        scheduled: this.step5Entries.filter(e => e.result === 'scheduled').length,
        discarded: this.step5Entries.filter(e => e.result === 'discarded').length
      },
      discard_reasons: this.getStep5DiscardReasons(),
      cache_stats: {
        cached: this.step5Entries.filter(e => e.cached).length,
        uncached: this.step5Entries.filter(e => !e.cached).length
      },
      entries: this.step5Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeStep6(): void {
    const filename = path.join(this.debugDir, 'interest_matching.json');
    const data = {
      step: 'Interest Matching',
      description: 'GPT matching of events to user interests',
      total_entries: this.step6Entries.length,
      result_counts: {
        matched: this.step6Entries.filter(e => e.result === 'matched').length,
        discarded: this.step6Entries.filter(e => e.result === 'discarded').length
      },
      cache_stats: {
        cached: this.step6Entries.filter(e => e.cached).length,
        uncached: this.step6Entries.filter(e => !e.cached).length
      },
      entries: this.step6Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private getStep5DiscardReasons(): Record<string, number> {
    const reasons: Record<string, number> = {};
    this.step5Entries
      .filter(e => e.result === 'discarded' && e.discard_reason)
      .forEach(e => {
        const reason = e.discard_reason!;
        reasons[reason] = (reasons[reason] || 0) + 1;
      });
    return reasons;
  }

  private writeStep7(): void {
    const filename = path.join(this.debugDir, 'event_description.json');
    const data = {
      step: 'Event Description Generation',
      description: 'GPT-based event description extraction (title, summary)',
      total_entries: this.step7Entries.length,
      result_counts: {
        successful: this.step7Entries.filter(e => e.extraction_success).length,
        failed: this.step7Entries.filter(e => !e.extraction_success).length
      },
      cache_stats: {
        cached: this.step7Entries.filter(e => e.cached).length,
        uncached: this.step7Entries.filter(e => !e.cached).length
      },
      entries: this.step7Entries
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }
}

export const debugWriter = new DebugWriter();