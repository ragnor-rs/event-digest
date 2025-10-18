import {
  DebugEventDetectionEntry,
  DebugTypeClassificationEntry,
  DebugScheduleFilteringEntry,
  DebugInterestMatchingEntry,
  DebugEventDescriptionEntry,
} from '../types';

/**
 * Interface for debug output operations
 * This allows the application layer to remain independent of specific debug implementations
 */
export interface IDebugWriter {
  /**
   * Write event detection debug entries
   */
  writeEventDetection(entries: DebugEventDetectionEntry[]): void;

  /**
   * Add a type classification debug entry
   */
  addTypeClassificationEntry(entry: DebugTypeClassificationEntry): void;

  /**
   * Add a schedule filtering debug entry
   */
  addScheduleFilteringEntry(entry: DebugScheduleFilteringEntry): void;

  /**
   * Add an interest matching debug entry
   */
  addInterestMatchingEntry(entry: DebugInterestMatchingEntry): void;

  /**
   * Add an event description debug entry
   */
  addEventDescriptionEntry(entry: DebugEventDescriptionEntry): void;

  /**
   * Write all accumulated debug entries to files
   */
  writeAll(): void;
}
