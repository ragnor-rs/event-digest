import { Config } from '../config/types';
import { IAIClient, ICache, IMessageSource } from '../domain/interfaces';
import { Event } from '../domain/entities';
import {
  filterByEventCues,
  detectEventAnnouncements,
  classifyEventTypes,
  filterBySchedule,
  filterByInterests,
  describeEvents,
} from '../domain/services';
import {
  DebugEventDetectionEntry,
  DebugTypeClassificationEntry,
  DebugScheduleFilteringEntry,
  DebugInterestMatchingEntry,
  DebugEventDescriptionEntry,
} from '../domain/types';
import { DebugWriter } from '../presentation/debug-writer';
import { Logger } from '../shared/logger';

export class EventPipeline {
  constructor(
    private config: Config,
    private aiClient: IAIClient,
    private cache: ICache,
    private messageSource: IMessageSource,
    private debugWriter: DebugWriter,
    private logger: Logger
  ) {}

  async execute(): Promise<Event[]> {
    try {

      // Connect to message source
      await this.messageSource.connect();
      this.logger.log('');

      // Step 1: Fetch messages from message source
      this.logger.log('Step 1/7: Fetching messages from message source...');
      const allMessages = await this.messageSource.fetchMessages(
        this.config.groupsToParse,
        this.config.channelsToParse,
        this.config.maxGroupMessages,
        this.config.maxChannelMessages
      );
      this.logger.log('');

      // Step 2: Filter by event cues
      this.logger.log(`Step 2/7: Filtering ${allMessages.length} messages by event cues...`);
      const eventCueMessages = await filterByEventCues(allMessages, this.config, this.logger);
      this.logger.log('');

      // Step 3: Detect event announcements with GPT
      this.logger.log(`Step 3/7: Detecting event announcements with GPT from ${eventCueMessages.length} messages...`);
      const debugEventDetection: DebugEventDetectionEntry[] = [];
      const events = await detectEventAnnouncements(
        eventCueMessages,
        this.config,
        this.aiClient,
        this.cache,
        debugEventDetection,
        this.logger
      );
      if (this.config.writeDebugFiles) {
        this.debugWriter.writeEventDetection(debugEventDetection);
      }
      this.logger.log('');

      // Step 4: Classify event types (offline/online/hybrid)
      this.logger.log(`Step 4/7: Classifying event types for ${events.length} events...`);
      const debugTypeClassification: DebugTypeClassificationEntry[] = [];
      const classifiedEvents = await classifyEventTypes(
        events,
        this.config,
        this.aiClient,
        this.cache,
        debugTypeClassification,
        this.logger
      );
      debugTypeClassification.forEach((entry) => this.debugWriter.addTypeClassificationEntry(entry));
      this.logger.log('');

      // Step 5: Filter by schedule
      this.logger.log(`Step 5/7: Filtering ${classifiedEvents.length} events by schedule and availability...`);
      const debugScheduleFiltering: DebugScheduleFilteringEntry[] = [];
      const scheduledEvents = await filterBySchedule(
        classifiedEvents,
        this.config,
        this.aiClient,
        this.cache,
        debugScheduleFiltering,
        this.logger
      );
      debugScheduleFiltering.forEach((entry) => this.debugWriter.addScheduleFilteringEntry(entry));
      this.logger.log('');

      // Step 6: Match to user interests
      this.logger.log(`Step 6/7: Matching ${scheduledEvents.length} events to user interests...`);
      const debugInterestMatching: DebugInterestMatchingEntry[] = [];
      const matchedEvents = await filterByInterests(
        scheduledEvents,
        this.config,
        this.aiClient,
        this.cache,
        debugInterestMatching,
        this.logger
      );
      debugInterestMatching.forEach((entry) => this.debugWriter.addInterestMatchingEntry(entry));
      this.logger.log('');

      // Step 7: Generate event descriptions
      this.logger.log(`Step 7/7: Generating descriptions for ${matchedEvents.length} events...`);
      const debugEventDescription: DebugEventDescriptionEntry[] = [];
      const describedEvents = await describeEvents(
        matchedEvents,
        this.config,
        this.aiClient,
        this.cache,
        debugEventDescription,
        this.logger
      );
      debugEventDescription.forEach((entry) => this.debugWriter.addEventDescriptionEntry(entry));
      this.logger.log('');

      // Write debug files if enabled
      if (this.config.writeDebugFiles) {
        this.debugWriter.writeAll();
        this.logger.log('');
      }

      return describedEvents;
    } catch (error) {
      this.logger.error('Pipeline execution failed:', error);
      throw error;
    } finally {
      // Always ensure both cache save and Telegram disconnect are attempted
      const cleanupErrors: Error[] = [];

      try {
        this.cache.save();
      } catch (error) {
        cleanupErrors.push(new Error(`Cache save failed: ${error instanceof Error ? error.message : String(error)}`));
      }

      try {
        await this.messageSource.disconnect();
      } catch (error) {
        cleanupErrors.push(
          new Error(`Telegram disconnect failed: ${error instanceof Error ? error.message : String(error)}`)
        );
      }

      if (cleanupErrors.length > 0) {
        this.logger.error('Cleanup encountered errors:', cleanupErrors.map((e) => e.message).join('; '));
      }
    }
  }
}
