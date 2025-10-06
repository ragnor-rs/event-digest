import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from './config';
import { TelegramClient } from './telegram';
import { filterByEventCues, detectEventAnnouncements, classifyEventTypes, filterByInterests, filterBySchedule } from './filters';
import { describeEvents, printEvents } from './events';
import { Cache } from './cache';
import { debugWriter } from './debug';

async function main() {
  try {
    console.log('Starting Event Digest CLI...\n');

    const config = parseArgs();
    const cache = new Cache();

    const telegramClient = new TelegramClient(cache);
    await telegramClient.connect();
    console.log('');

    console.log('Step 1: Fetching messages...');
    const allMessages = await telegramClient.fetchMessages(config);
    console.log(`  Fetched ${allMessages.length} total messages\n`);

    const eventCueMessages = await filterByEventCues(allMessages, config);
    console.log('');

    const events = await detectEventAnnouncements(eventCueMessages, config);
    console.log('');

    const classifiedEvents = await classifyEventTypes(events, config);
    console.log('');

    const scheduledEvents = await filterBySchedule(classifiedEvents, config);
    console.log('');

    const matchedEvents = await filterByInterests(scheduledEvents, config);
    console.log('');

    const describedEvents = await describeEvents(matchedEvents, config);
    console.log('');

    printEvents(describedEvents);
    console.log('');

    // Write debug files if enabled
    if (config.writeDebugFiles) {
      debugWriter.writeAll();
      console.log('');
    }

    await telegramClient.disconnect();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();