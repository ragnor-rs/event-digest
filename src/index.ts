import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from './config';
import { OpenAIClient, Cache, TelegramClient } from './data';
import { EventPipeline } from './application';
import { printEvents } from './presentation';
import { Logger } from './shared/logger';

async function main() {
  try {
    const config = parseArgs();

    const logger = new Logger(config.verboseLogging);
    const cache = new Cache();
    const openaiClient = new OpenAIClient();
    const telegramClient = new TelegramClient(cache);

    const pipeline = new EventPipeline(config, openaiClient, cache, telegramClient, logger);
    const events = await pipeline.execute();

    printEvents(events);
    logger.log('');
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('Error:', error);
    }
    process.exit(1);
  }
}

main();
