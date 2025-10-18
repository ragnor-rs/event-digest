import { EventDescription } from './event-description';
import { EventType } from './event-type';
import { InterestMatch } from './interest-match';
import { SourceMessage } from './source-message';

export interface DigestEvent {
  message: SourceMessage;
  event_type?: EventType;
  interests_matched?: string[];
  interest_matches?: InterestMatch[];
  start_datetime?: string;
  event_description?: EventDescription;
}
