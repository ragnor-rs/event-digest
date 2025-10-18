import { Config } from '../../config/types';
import { Logger } from '../../shared/logger';
import { SourceMessage } from '../entities';

export async function filterByEventCues(
  messages: SourceMessage[],
  config: Config,
  logger: Logger
): Promise<SourceMessage[]> {
  const eventMessages = messages.filter((msg) => {
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
