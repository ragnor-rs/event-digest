import dotenv from 'dotenv';

dotenv.config();

import { EventPipeline } from './application';
import { parseArgs } from './config';
import { OpenAIClient, Cache, TelegramClient } from './data';
import { printEvents, EventSender } from './presentation';
import { Logger, DebugWriter } from './shared';

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
  const logger = new Logger(false);
  let messageSource: TelegramClient | undefined;

  try {
    validateEnvironmentVariables();
    const config = parseArgs();

    logger.setVerbose(config.verboseLogging);
    const cache = new Cache(logger);
    const openaiClient = new OpenAIClient(logger);
    messageSource = new TelegramClient(cache, logger);
    const debugWriter = new DebugWriter(logger);

    // Connect to Telegram
    await messageSource.connect();
    logger.log('');

    const pipeline = new EventPipeline(config, openaiClient, cache, messageSource, debugWriter, logger);
    const events = await pipeline.execute();

    // Send events to recipient if configured, otherwise print to console
    if (config.sendEventsRecipient) {
      const eventSender = new EventSender(config, messageSource, logger);
      await eventSender.sendEvents(events);
    } else {
      printEvents(events);
    }
    logger.log('');
  } catch (error) {
    logger.error('Fatal error:', error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  } finally {
    // Always disconnect from Telegram if connected
    if (messageSource) {
      try {
        await messageSource.disconnect();
      } catch (error) {
        logger.error('Telegram disconnect failed:', error);
      }
    }
  }
}

main();
