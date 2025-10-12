import dotenv from 'dotenv';
dotenv.config();

import { parseArgs } from './config';
import { OpenAIClient, Cache, TelegramClient } from './data';
import { EventPipeline } from './application';
import { printEvents } from './presentation';
import { Logger } from './shared/logger';

function validateEnvironmentVariables(): void {
  const requiredVars = ['OPENAI_API_KEY', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_PHONE_NUMBER'];

  const missingVars = requiredVars.filter((varName) => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}\n` +
        'Please create a .env file with these variables. See .env.example for reference.'
    );
  }
}

async function main() {
  try {
    validateEnvironmentVariables();
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
