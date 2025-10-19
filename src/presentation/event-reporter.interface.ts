import { DigestEvent } from '../domain/entities';

/**
 * Interface for reporting/outputting digest events
 * Allows the bootstrap layer to switch between different presentation strategies
 * (console printing, Telegram sending, email, etc.) without modification
 */
export interface IEventReporter {
  /**
   * Report events to the configured destination
   * @param events Array of digest events to report
   */
  report(events: DigestEvent[]): Promise<void>;
}
