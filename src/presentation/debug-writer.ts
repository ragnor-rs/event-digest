import * as fs from 'fs';
import * as path from 'path';

import {
  DebugEventDetectionEntry,
  DebugTypeClassificationEntry,
  DebugScheduleFilteringEntry,
  DebugInterestMatchingEntry,
  DebugEventDescriptionEntry,
} from '../domain/types';
import { EventType } from '../domain/entities';
import { Logger } from '../shared/logger';

export class DebugWriter {
  private debugDir = 'debug';
  private eventDetectionEntries: DebugEventDetectionEntry[] = [];
  private typeClassificationEntries: DebugTypeClassificationEntry[] = [];
  private scheduleFilteringEntries: DebugScheduleFilteringEntry[] = [];
  private interestMatchingEntries: DebugInterestMatchingEntry[] = [];
  private eventDescriptionEntries: DebugEventDescriptionEntry[] = [];
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    // Create debug directory if it doesn't exist
    if (!fs.existsSync(this.debugDir)) {
      fs.mkdirSync(this.debugDir, { recursive: true });
    }
  }

  writeEventDetection(entries: DebugEventDetectionEntry[]): void {
    this.eventDetectionEntries = entries;
    this.writeEventDetectionFile();
  }

  addTypeClassificationEntry(entry: DebugTypeClassificationEntry): void {
    this.typeClassificationEntries.push(entry);
  }

  addScheduleFilteringEntry(entry: DebugScheduleFilteringEntry): void {
    this.scheduleFilteringEntries.push(entry);
  }

  addInterestMatchingEntry(entry: DebugInterestMatchingEntry): void {
    this.interestMatchingEntries.push(entry);
  }

  addEventDescriptionEntry(entry: DebugEventDescriptionEntry): void {
    this.eventDescriptionEntries.push(entry);
  }

  writeAll(): void {
    this.writeTypeClassification();
    this.writeScheduleFiltering();
    this.writeInterestMatching();
    this.writeEventDescription();
    this.logger.log(`Debug files written to ${this.debugDir}/ directory`);
  }

  private writeEventDetectionFile(): void {
    const filename = path.join(this.debugDir, 'event_detection.json');
    const data = {
      step: 'AI Event Detection',
      description: 'AI filtering to identify single event announcements',
      total_entries: this.eventDetectionEntries.length,
      result_counts: {
        is_event: this.eventDetectionEntries.filter((e) => e.isEvent).length,
        not_event: this.eventDetectionEntries.filter((e) => !e.isEvent).length,
      },
      cache_stats: {
        cached: this.eventDetectionEntries.filter((e) => e.cached).length,
        uncached: this.eventDetectionEntries.filter((e) => !e.cached).length,
      },
      results: this.eventDetectionEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeTypeClassification(): void {
    const filename = path.join(this.debugDir, 'event_classification.json');
    const data = {
      step: 'Event Type Classification',
      description: 'Index-based AI classification of events as offline (0), online (1), or hybrid (2)',
      total_entries: this.typeClassificationEntries.length,
      result_counts: {
        hybrid: this.typeClassificationEntries.filter((e) => e.result === EventType.HYBRID).length,
        offline: this.typeClassificationEntries.filter((e) => e.result === EventType.OFFLINE).length,
        online: this.typeClassificationEntries.filter((e) => e.result === EventType.ONLINE).length,
        discarded: this.typeClassificationEntries.filter((e) => e.result === 'discarded').length,
      },
      cache_stats: {
        cached: this.typeClassificationEntries.filter((e) => e.cached).length,
        uncached: this.typeClassificationEntries.filter((e) => !e.cached).length,
      },
      entries: this.typeClassificationEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeScheduleFiltering(): void {
    const filename = path.join(this.debugDir, 'schedule_filtering.json');
    const data = {
      step: 'Schedule Filtering',
      description: 'AI datetime extraction and schedule matching',
      total_entries: this.scheduleFilteringEntries.length,
      result_counts: {
        scheduled: this.scheduleFilteringEntries.filter((e) => e.result === 'scheduled').length,
        discarded: this.scheduleFilteringEntries.filter((e) => e.result === 'discarded').length,
      },
      discard_reasons: this.getScheduleFilteringDiscardReasons(),
      cache_stats: {
        cached: this.scheduleFilteringEntries.filter((e) => e.cached).length,
        uncached: this.scheduleFilteringEntries.filter((e) => !e.cached).length,
      },
      entries: this.scheduleFilteringEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private writeInterestMatching(): void {
    const filename = path.join(this.debugDir, 'interest_matching.json');
    const data = {
      step: 'Interest Matching',
      description: 'AI matching of events to user interests',
      total_entries: this.interestMatchingEntries.length,
      result_counts: {
        matched: this.interestMatchingEntries.filter((e) => e.result === 'matched').length,
        discarded: this.interestMatchingEntries.filter((e) => e.result === 'discarded').length,
      },
      cache_stats: {
        cached: this.interestMatchingEntries.filter((e) => e.cached).length,
        uncached: this.interestMatchingEntries.filter((e) => !e.cached).length,
      },
      entries: this.interestMatchingEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private getScheduleFilteringDiscardReasons(): Record<string, number> {
    const reasons: Record<string, number> = {};
    this.scheduleFilteringEntries
      .filter((e) => e.result === 'discarded' && e.discard_reason)
      .forEach((e) => {
        const reason = e.discard_reason!;
        reasons[reason] = (reasons[reason] || 0) + 1;
      });
    return reasons;
  }

  private writeEventDescription(): void {
    const filename = path.join(this.debugDir, 'event_description.json');
    const data = {
      step: 'Event Description Generation',
      description: 'AI-based event description extraction (title, summary)',
      total_entries: this.eventDescriptionEntries.length,
      result_counts: {
        successful: this.eventDescriptionEntries.filter((e) => e.extraction_success).length,
        failed: this.eventDescriptionEntries.filter((e) => !e.extraction_success).length,
      },
      cache_stats: {
        cached: this.eventDescriptionEntries.filter((e) => e.cached).length,
        uncached: this.eventDescriptionEntries.filter((e) => !e.cached).length,
      },
      entries: this.eventDescriptionEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }
}
