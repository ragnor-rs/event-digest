import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from './config';
import { TelegramClient } from './telegram';
import { filterEventMessages, filterWithGPT, filterByInterests, filterBySchedule } from './filters';
import { convertToEvents, printEvents } from './events';
import { Cache } from './cache';

async function main() {
  try {
    console.log('Starting Event Digest CLI...\n');

    const config = parseArgs();
    console.log('Configuration loaded successfully');

    const telegramClient = new TelegramClient();
    await telegramClient.connect();
    console.log('');

    console.log('Step 1: Fetching messages...');
    const allMessages = await telegramClient.fetchMessages(config);
    console.log(`  Fetched ${allMessages.length} total messages\n`);

    const eventCueMessages = await filterEventMessages(allMessages, config);
    console.log('');

    const eventMessages = await filterWithGPT(eventCueMessages);
    console.log('');

    const interestingMessages = await filterByInterests(eventMessages, config);
    console.log('');

    const scheduledMessages = await filterBySchedule(interestingMessages, config);
    console.log('');

    const events = await convertToEvents(scheduledMessages, config);
    console.log('');

    printEvents(events);
    console.log('');

    await telegramClient.disconnect();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();