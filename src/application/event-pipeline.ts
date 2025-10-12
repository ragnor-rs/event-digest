import { Config } from '../config/types';
import { Event } from '../domain/entities';
import { OpenAIClient } from '../data/openai-client';
import { Cache } from '../data/cache';
import { TelegramClient } from '../data/telegram-client';
import { Logger } from '../shared/logger';
import {
  filterByEventCues,
  detectEventAnnouncements,
  classifyEventTypes,
  filterBySchedule,
  filterByInterests,
  describeEvents,
} from '../domain/services';
import {
  debugWriter,
  DebugEventDetectionEntry,
  DebugTypeClassificationEntry,
  DebugScheduleFilteringEntry,
  DebugInterestMatchingEntry,
  DebugEventDescriptionEntry,
} from '../presentation/debug-writer';

export class EventPipeline {
  constructor(
    private config: Config,
    private openaiClient: OpenAIClient,
    private cache: Cache,
    private telegramClient: TelegramClient,
    private logger: Logger
  ) {}

  async execute(): Promise<Event[]> {
    this.logger.log('Starting Event Digest CLI...\n');

    // Step 1: Fetch messages from Telegram
    await this.telegramClient.connect();
    this.logger.log('');

    const allMessages = await this.telegramClient.fetchMessages(this.config);
    this.logger.log('');

    // Step 2: Filter by event cues
    const eventCueMessages = await filterByEventCues(allMessages, this.config, this.logger);
    this.logger.log('');

    // Step 3: Detect event announcements with GPT
    const debugEventDetection: DebugEventDetectionEntry[] = [];
    const events = await detectEventAnnouncements(
      eventCueMessages,
      this.config,
      this.openaiClient,
      this.cache,
      debugEventDetection,
      this.logger
    );
    this.logger.log('');

    if (this.config.writeDebugFiles) {
      debugWriter.writeEventDetection(debugEventDetection);
    }

    // Step 4: Classify event types (offline/online/hybrid)
    const debugTypeClassification: DebugTypeClassificationEntry[] = [];
    const classifiedEvents = await classifyEventTypes(
      events,
      this.config,
      this.openaiClient,
      this.cache,
      debugTypeClassification,
      this.logger
    );
    this.logger.log('');

    debugTypeClassification.forEach((entry) => debugWriter.addTypeClassificationEntry(entry));

    // Step 5: Filter by schedule
    const debugScheduleFiltering: DebugScheduleFilteringEntry[] = [];
    const scheduledEvents = await filterBySchedule(
      classifiedEvents,
      this.config,
      this.openaiClient,
      this.cache,
      debugScheduleFiltering,
      this.logger
    );
    this.logger.log('');

    debugScheduleFiltering.forEach((entry) => debugWriter.addScheduleFilteringEntry(entry));

    // Step 6: Match to user interests
    const debugInterestMatching: DebugInterestMatchingEntry[] = [];
    const matchedEvents = await filterByInterests(
      scheduledEvents,
      this.config,
      this.openaiClient,
      this.cache,
      debugInterestMatching,
      this.logger
    );
    this.logger.log('');

    debugInterestMatching.forEach((entry) => debugWriter.addInterestMatchingEntry(entry));

    // Step 7: Generate event descriptions
    const debugEventDescription: DebugEventDescriptionEntry[] = [];
    const describedEvents = await describeEvents(
      matchedEvents,
      this.config,
      this.openaiClient,
      this.cache,
      debugEventDescription,
      this.logger
    );
    this.logger.log('');

    debugEventDescription.forEach((entry) => debugWriter.addEventDescriptionEntry(entry));

    // Write debug files if enabled
    if (this.config.writeDebugFiles) {
      debugWriter.writeAll();
      this.logger.log('');
    }

    await this.telegramClient.disconnect();

    return describedEvents;
  }
}
