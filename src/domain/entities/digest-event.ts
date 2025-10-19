import { DigestEventDescription } from './digest-event-description';
import { EventTypeClassification } from './event-type-classification';
import { InterestMatch } from './interest-match';
import { SourceMessage } from './source-message';

export interface DigestEvent {
  message: SourceMessage;
  event_detection_confidence?: number; // Step 3: 0.0-1.0 confidence this is an event
  event_type_classification?: EventTypeClassification; // Step 4: event type with confidence
  interest_matches?: InterestMatch[]; // Step 6: matched interests with confidence scores
  start_datetime?: Date;
  event_description?: DigestEventDescription;
}
