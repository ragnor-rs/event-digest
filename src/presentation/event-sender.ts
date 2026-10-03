import { buildGoogleCalendarUrl } from './calendar-link';
import { IEventReporter } from './event-reporter.interface';
import { escapeHtml } from './html-escape';
import { Config } from '../config/types';
import { DigestEvent, formatLocation, postLink } from '../domain/entities';
import { IMessageSource } from '../domain/interfaces';
import { delay, Logger, RATE_LIMIT_DELAY } from '../shared';
import { formatEventDateTime } from '../shared/date-utils';

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

      // Space the batches out so a multi-message digest does not arrive as a
      // burst, which is what Telegram rate-limits on. Skipped after the last
      // batch: there is nothing following it to be spaced from.
      if (batchIndex < batches.length - 1) {
        await delay(RATE_LIMIT_DELAY);
      }
    }

    this.logger.log('All events sent successfully');
  }

  /**
   * Format a batch of events into a single message
   */
  private formatBatchMessage(events: DigestEvent[], batchIndex: number, totalBatches: number): string {
    const today = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const header =
      totalBatches > 1
        ? `EVENT DIGEST (${today}) — Batch ${batchIndex + 1}/${totalBatches}\n\n`
        : `EVENT DIGEST (${today})\n\n`;

    // Every interpolated value below is escaped: the message is sent in HTML
    // parse mode so the calendar URL can hide behind a label, which makes any
    // stray "&" or "<" in a title, summary or venue name a parse error that
    // would cost the whole batch.
    const eventTexts = events.map((event, index) => {
      const globalIndex = batchIndex * this.config.sendEventsBatchSize + index + 1;
      const datetime = escapeHtml(formatEventDateTime(event.start_datetime!, event.start_time_known !== false));
      const summary = escapeHtml(event.event_description!.short_summary);
      // The title carries the link to the announcement, which is why there is no
      // separate 🔗 line. It points at the posting the digest kept; where step 9
      // merged several, the others are not linked — one obvious target beats a
      // row of numbered ones, and they are copies of what this already opens.
      const title = `<a href="${escapeHtml(postLink(event.message))}">${escapeHtml(event.event_description!.title)}</a>`;
      // Omitted rather than shown as "unknown": an announcement that named no
      // venue has nothing to print, and a placeholder line only adds noise.
      const venue = event.event_location ? escapeHtml(formatLocation(event.event_location)) : '';
      const where = venue ? `📍 ${venue}\n` : '';
      // The calendar URL is ~250 characters of query string, so it hides too.
      const calendar = `<a href="${escapeHtml(buildGoogleCalendarUrl(event))}">Add to calendar</a>`;

      // Why step 8 kept the event. Placed between 📍 and 📝 to match the console
      // reporter, so the two render the same event in the same order. Escaped like
      // everything else: an interest is free text and "Handcrafting, DIY & makers"
      // would otherwise cost the whole batch.
      const tags = escapeHtml(event.interest_matches!.map((m) => m.interest).join(', '));

      return (
        `${globalIndex}. ${title}\n` +
        `📅 ${datetime}\n` +
        where +
        `🏷️ ${tags}\n` +
        `📝 ${summary}\n` +
        `➕ ${calendar}`
      );
    });

    return header + eventTexts.join('\n\n');
  }
}
