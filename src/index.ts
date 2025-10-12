import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from './config';
import { OpenAIClient, Cache, TelegramClient } from './data';
import { EventPipeline } from './application';
import { printEvents } from './presentation';

async function main() {
  try {
    const config = parseArgs();
    const cache = new Cache();
    const openaiClient = new OpenAIClient();
    const telegramClient = new TelegramClient(cache);

    const pipeline = new EventPipeline(config, openaiClient, cache, telegramClient);
    const events = await pipeline.execute();

    printEvents(events);
    console.log('');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
