import * as fs from 'fs';
import * as path from 'path';

import { Logger } from './logger';
import {
  DebugDigestSplittingEntry,
  DebugEventDetectionEntry,
  DebugTypeClassificationEntry,
  DebugScheduleFilteringEntry,
  DebugLocationFilteringEntry,
  DebugInterestMatchingEntry,
  DebugEventDescriptionEntry,
} from './types';

export class DebugWriter {
  private debugDir = 'debug';
  private digestSplittingEntries: DebugDigestSplittingEntry[] = [];
  private eventDetectionEntries: DebugEventDetectionEntry[] = [];
  private typeClassificationEntries: DebugTypeClassificationEntry[] = [];
  private scheduleFilteringEntries: DebugScheduleFilteringEntry[] = [];
  private locationFilteringEntries: DebugLocationFilteringEntry[] = [];
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

  writeDigestSplitting(entries: DebugDigestSplittingEntry[]): void {
    this.digestSplittingEntries = entries;
    this.writeDigestSplittingFile();
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

  addLocationFilteringEntry(entry: DebugLocationFilteringEntry): void {
    this.locationFilteringEntries.push(entry);
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
    this.writeLocationFiltering();
    this.writeInterestMatching();
    this.writeEventDescription();
    this.logger.log(`Debug files written to ${this.debugDir}/ directory`);
  }

  private writeDigestSplittingFile(): void {
    const filename = path.join(this.debugDir, 'digest_splitting.json');
    const digests = this.digestSplittingEntries.filter((e) => e.isDigest);
    const data = {
      step: 'Digest Splitting',
      description: 'Roundup posts listing several events, split into one message per event',
      // Candidates only: a message showing none of the gate's digest signals is
      // never offered to the model, so it has no entry here and reaches detection
      // unchanged. This count is the gate's output, not the step's input.
      total_entries: this.digestSplittingEntries.length,
      result_counts: {
        digest: digests.length,
        single: this.digestSplittingEntries.filter((e) => !e.isDigest && !e.truncated).length,
        // Counted apart from `single`: these were never judged, and folding them
        // in would read as the model having answered when it was cut off.
        skipped_truncated: this.digestSplittingEntries.filter((e) => e.truncated).length,
        events_extracted: digests.reduce((sum, e) => sum + e.fragments.length, 0),
      },
      cache_stats: {
        cached: this.digestSplittingEntries.filter((e) => e.cached).length,
        uncached: this.digestSplittingEntries.filter((e) => !e.cached).length,
      },
      results: this.digestSplittingEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
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
      description:
        'Index-based AI classification of events as offline (0), online (1), or hybrid (2) with confidence scores',
      total_entries: this.typeClassificationEntries.length,
      result_counts: {
        matched: this.typeClassificationEntries.filter((e) => e.result === 'matched').length,
        discarded: this.typeClassificationEntries.filter((e) => e.result === 'discarded').length,
      },
      type_counts: {
        hybrid: this.typeClassificationEntries.filter((e) => e.type_classifications.some((t) => t.type === 'hybrid'))
          .length,
        offline: this.typeClassificationEntries.filter((e) => e.type_classifications.some((t) => t.type === 'offline'))
          .length,
        online: this.typeClassificationEntries.filter((e) => e.type_classifications.some((t) => t.type === 'online'))
          .length,
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
      discard_reasons: this.countDiscardReasons(this.scheduleFilteringEntries),
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

  private writeLocationFiltering(): void {
    const filename = path.join(this.debugDir, 'location_filtering.json');
    const data = {
      step: 'Location Filtering',
      description: 'AI venue/address extraction and matching against the configured locations',
      total_entries: this.locationFilteringEntries.length,
      result_counts: {
        located: this.locationFilteringEntries.filter((e) => e.result === 'located').length,
        discarded: this.locationFilteringEntries.filter((e) => e.result === 'discarded').length,
      },
      discard_reasons: this.countDiscardReasons(this.locationFilteringEntries),
      cache_stats: {
        cached: this.locationFilteringEntries.filter((e) => e.cached).length,
        uncached: this.locationFilteringEntries.filter((e) => !e.cached).length,
      },
      entries: this.locationFilteringEntries,
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  }

  private countDiscardReasons(entries: Array<{ result: string; discard_reason?: string }>): Record<string, number> {
    const reasons: Record<string, number> = {};
    entries
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
