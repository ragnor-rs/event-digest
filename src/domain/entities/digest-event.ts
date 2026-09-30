import { DigestEventDescription } from './digest-event-description';
import { EventLocation } from './event-location';
import { EventTypeClassification } from './event-type-classification';
import { InterestMatch } from './interest-match';
import { SourceMessage } from './source-message';

export interface DigestEvent {
  message: SourceMessage;
  event_detection_confidence?: number; // Step 3: 0.0-1.0 confidence this is an event
  event_type_classification?: EventTypeClassification; // Step 4: event type with confidence
  interest_matches?: InterestMatch[]; // Step 7: matched interests with confidence scores
  start_datetime?: Date;
  // Step 5: false when the announcement gave a date but no clock time. Such
  // events skip the timeslot check, so this flag is what stops them being
  // rendered with a time that was never stated.
  start_time_known?: boolean;
  // Step 6: venue/address as announced, plus the configured location it matched.
  // Absent when the announcement named no place at all.
  event_location?: EventLocation;
  // Step 8: other postings of the same event, collapsed by the deduplicator.
  duplicate_sources?: SourceMessage[];
  event_description?: DigestEventDescription; // Step 9: title + short summary
}
