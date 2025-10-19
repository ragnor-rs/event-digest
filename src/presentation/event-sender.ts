import { DigestEvent } from '../domain/entities';
import { IMessageSource } from '../domain/interfaces';
import { IEventReporter } from './event-reporter.interface';
import { Config } from '../config/types';
import { formatDateTime } from '../shared/date-utils';
import { Logger } from '../shared';

/**
 * Sends events as messages to a specified recipient in batches
 */
export class EventSender implements IEventReporter {
  constructor(
    private config: Config,
    private messageSource: IMessageSource,
    private logger: Logger
  ) {}

  /**
   * Report events by sending them to the configured recipient
   */
  async report(events: DigestEvent[]): Promise<void> {
    if (!this.config.sendEventsRecipient) {
      throw new Error('sendEventsRecipient is not configured');
    }

    if (events.length === 0) {
      this.logger.log('No events to send.');
      return;
    }

    // Validate all events have required fields
    const validEvents = events.filter((event) => {
      if (!event.event_description) {
        this.logger.verbose(`Skipping event without description: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.start_datetime) {
        this.logger.verbose(`Skipping event without start_datetime: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.event_description.title) {
        this.logger.verbose(`Skipping event without title: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.event_description.short_summary) {
        this.logger.verbose(`Skipping event without short_summary: ${event.message?.link || 'unknown'}`);
        return false;
      }
      if (!event.interest_matches || event.interest_matches.length === 0) {
        this.logger.verbose(`Skipping event without interest_matches: ${event.message?.link || 'unknown'}`);
        return false;
      }
      return true;
    });

    if (validEvents.length < events.length) {
      this.logger.log(`Filtered out ${events.length - validEvents.length} invalid event(s)`);
    }

    // Sort events by date in chronological order
    const sortedEvents = validEvents.sort((a, b) => {
      return a.start_datetime!.getTime() - b.start_datetime!.getTime();
    });

    this.logger.log(`Sending ${sortedEvents.length} events to ${this.config.sendEventsRecipient}...`);

    // Process events in batches
    const batchSize = this.config.sendEventsBatchSize;
    const batches: DigestEvent[][] = [];

    for (let i = 0; i < sortedEvents.length; i += batchSize) {
      batches.push(sortedEvents.slice(i, i + batchSize));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const message = this.formatBatchMessage(batch, batchIndex, batches.length);

      try {
        await this.messageSource.sendMessage(this.config.sendEventsRecipient, message);
        this.logger.log(`Sent batch ${batchIndex + 1}/${batches.length} (${batch.length} events)`);
      } catch (error) {
        this.logger.error(`Failed to send batch ${batchIndex + 1}/${batches.length}`, error);
        throw error;
      }
    }

    this.logger.log('All events sent successfully');
  }

  /**
   * Format a batch of events into a single message
   */
  private formatBatchMessage(events: DigestEvent[], batchIndex: number, totalBatches: number): string {
    const header = totalBatches > 1
      ? `📅 EVENT DIGEST (${batchIndex + 1}/${totalBatches})\n\n`
      : `📅 EVENT DIGEST\n\n`;

    const eventTexts = events.map((event, index) => {
      const globalIndex = batchIndex * this.config.sendEventsBatchSize + index + 1;
      const title = event.event_description!.title;
      const datetime = formatDateTime(event.start_datetime!);
      const interests = event.interest_matches!.map((m) => m.interest).join(', ');
      const summary = event.event_description!.short_summary;
      const link = event.message.link;

      return (
        `${globalIndex}. ${title}\n` +
        `📅 ${datetime}\n` +
        `🏷️ ${interests}\n` +
        `📝 ${summary}\n` +
        `🔗 ${link}`
      );
    });

    return header + eventTexts.join('\n\n');
  }
}
