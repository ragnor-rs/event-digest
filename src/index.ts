import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from './config';
import { TelegramClient } from './telegram';
import { filterByEventCues, detectEventAnnouncements, classifyEventTypes, filterByInterests, filterBySchedule } from './filters';
import { convertToEvents, printEvents } from './events';
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

    const eventMessages = await detectEventAnnouncements(eventCueMessages, config);
    console.log('');

    const eventAnnouncements = await classifyEventTypes(eventMessages, config);
    console.log('');

    const interestingMessages = await filterByInterests(eventAnnouncements, config);
    console.log('');

    const scheduledMessages = await filterBySchedule(interestingMessages, config);
    console.log('');

    const events = await convertToEvents(scheduledMessages, config);
    console.log('');

    printEvents(events);
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