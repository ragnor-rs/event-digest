import { DigestEventDescription } from './digest-event-description';
import { AttendanceMode } from './attendance-mode';
import { InterestMatch } from './interest-match';
import { SourceMessage } from './source-message';

export interface DigestEvent {
  message: SourceMessage;
  event_type?: AttendanceMode;
  interest_matches?: InterestMatch[];
  start_datetime?: Date;
  event_description?: DigestEventDescription;
}
