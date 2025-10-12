import dotenv from 'dotenv';

dotenv.config();

import { EventPipeline } from './application';
import { parseArgs } from './config';
import { OpenAIClient, Cache, TelegramClient } from './data';
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
    const cache = new Cache(logger);
    const openaiClient = new OpenAIClient();
    const telegramClient = new TelegramClient(cache, logger);

    const pipeline = new EventPipeline(config, openaiClient, cache, telegramClient, logger);
    const events = await pipeline.execute();

    printEvents(events);
    logger.log('');
  } catch (error) {
    const logger = new Logger(false);
    if (error instanceof Error) {
      logger.error('Error', error);
    } else {
      logger.error('Error', error);
    }
    process.exit(1);
  }
}

main();
