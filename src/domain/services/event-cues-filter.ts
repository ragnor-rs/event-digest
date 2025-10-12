import { TelegramMessage } from '../entities';
import { Config } from '../../config/types';
import { Logger } from '../../shared/logger';

export async function filterByEventCues(messages: TelegramMessage[], config: Config, logger: Logger): Promise<TelegramMessage[]> {
  logger.log(`Filtering ${messages.length} messages by event cues...`);

  const eventMessages = messages.filter(msg => {
    const content = msg.content.toLowerCase();
    for (const lang in config.eventMessageCues) {
      for (const cue of config.eventMessageCues[lang]) {
        if (content.includes(cue.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  });

  logger.log(`  Found ${eventMessages.length} messages with event cues`);
  return eventMessages;
}
