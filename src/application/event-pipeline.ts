import { Config } from '../config/types';
import { Event } from '../domain/entities';
import { OpenAIClient } from '../data/openai-client';
import { Cache } from '../data/cache';
import { TelegramClient } from '../data/telegram-client';
import {
  filterByEventCues,
  detectEventAnnouncements,
  classifyEventTypes,
  filterBySchedule,
  filterByInterests,
  describeEvents
} from '../domain/services';
import { debugWriter } from '../presentation/debug-writer';

export class EventPipeline {
  constructor(
    private config: Config,
    private openaiClient: OpenAIClient,
    private cache: Cache,
    private telegramClient: TelegramClient
  ) {}

  async execute(): Promise<Event[]> {
    console.log('Starting Event Digest CLI...\n');

    // Step 1: Fetch messages from Telegram
    await this.telegramClient.connect();
    console.log('');

    const allMessages = await this.telegramClient.fetchMessages(this.config);
    console.log('');

    // Step 2: Filter by event cues
    const eventCueMessages = await filterByEventCues(allMessages, this.config);
    console.log('');

    // Step 3: Detect event announcements with GPT
    const debugEventDetection: any[] = [];
    const events = await detectEventAnnouncements(
      eventCueMessages,
      this.config,
      this.openaiClient,
      this.cache,
      debugEventDetection
    );
    console.log('');

    if (this.config.writeDebugFiles) {
      debugWriter.writeEventDetection(debugEventDetection);
    }

    // Step 4: Classify event types (offline/online/hybrid)
    const debugTypeClassification: any[] = [];
    const classifiedEvents = await classifyEventTypes(
      events,
      this.config,
      this.openaiClient,
      this.cache,
      debugTypeClassification
    );
    console.log('');

    debugTypeClassification.forEach(entry => debugWriter.addTypeClassificationEntry(entry));

    // Step 5: Filter by schedule
    const debugScheduleFiltering: any[] = [];
    const scheduledEvents = await filterBySchedule(
      classifiedEvents,
      this.config,
      this.openaiClient,
      this.cache,
      debugScheduleFiltering
    );
    console.log('');

    debugScheduleFiltering.forEach(entry => debugWriter.addScheduleFilteringEntry(entry));

    // Step 6: Match to user interests
    const debugInterestMatching: any[] = [];
    const matchedEvents = await filterByInterests(
      scheduledEvents,
      this.config,
      this.openaiClient,
      this.cache,
      debugInterestMatching
    );
    console.log('');

    debugInterestMatching.forEach(entry => debugWriter.addInterestMatchingEntry(entry));

    // Step 7: Generate event descriptions
    const debugEventDescription: any[] = [];
    const describedEvents = await describeEvents(
      matchedEvents,
      this.config,
      this.openaiClient,
      this.cache,
      debugEventDescription
    );
    console.log('');

    debugEventDescription.forEach(entry => debugWriter.addEventDescriptionEntry(entry));

    // Write debug files if enabled
    if (this.config.writeDebugFiles) {
      debugWriter.writeAll();
      console.log('');
    }

    await this.telegramClient.disconnect();

    return describedEvents;
  }
}
