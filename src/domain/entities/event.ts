import { TelegramMessage } from './telegram-message';
import { InterestMatch } from './interest-match';
import { EventDescription } from './event-description';

export interface Event {
  message: TelegramMessage;
  event_type?: 'offline' | 'online' | 'hybrid';
  interests_matched?: string[];
  interest_matches?: InterestMatch[];
  start_datetime?: string;
  event_description?: EventDescription;
}
