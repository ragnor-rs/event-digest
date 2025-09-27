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
    console.log('Configuration loaded successfully\n');

    const telegramClient = new TelegramClient();
    await telegramClient.connect();

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

    // Show cache statistics
    const cache = new Cache();
    const stats = cache.getStats();
    console.log('\n=== CACHE STATISTICS ===');
    console.log(`Step 3 cached: ${stats.step3_cached} messages`);
    console.log(`Step 4 cached: ${stats.step4_cached} messages`);
    console.log(`Step 5 cached: ${stats.step5_cached} messages`);
    console.log(`Step 6 cached: ${stats.step6_cached} messages`);
    console.log(`Total cached: ${stats.total_cached} results`);

    await telegramClient.disconnect();
    console.log('\nDisconnected from Telegram');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();