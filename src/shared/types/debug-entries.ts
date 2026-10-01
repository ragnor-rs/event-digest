/**
 * Shared debug entry types
 * These types use primitive types to avoid dependencies on domain entities
 * They are used by domain services to collect debug information
 */

export interface DebugDigestSplittingEntry {
  messageLink: string;
  /** Source text the decision was made from; needed to review or grade the call */
  messageContent: string;
  isDigest: boolean;
  /** One self-contained announcement per event; empty when the message is not a digest */
  fragments: string[];
  cached: boolean;
  /**
   * The batch this message was in was cut off by the completion limit, so it was
   * skipped and nothing was cached. `isDigest: false` here means "not judged",
   * not "judged and found single" — the next run re-asks.
   */
  truncated?: boolean;
  prompt?: string;
  aiResponse?: string;
}

export interface DebugEventDetectionEntry {
  messageLink: string;
  /** Source text the decision was made from; needed to review or grade the call */
  messageContent: string;
  isEvent: boolean;
  confidence?: number; // 0.0-1.0 confidence score from AI
  cached: boolean;
  prompt?: string;
  aiResponse?: string;
}

export interface DebugTypeClassificationEntry {
  message: {
    timestamp: Date;
    content: string;
    link: string;
  };
  ai_prompt: string;
  ai_response: string;
  type_classifications: Array<{
    type: 'offline' | 'online' | 'hybrid';
    confidence: number;
  }>;
  result: 'matched' | 'discarded';
  cached: boolean;
}

export interface DebugScheduleFilteringEntry {
  message: {
    timestamp: Date;
    content: string;
    link: string;
  };
  event_type: string;
  ai_prompt: string;
  ai_response: string;
  extracted_datetime: Date | string; // Date for valid datetimes, string for "unknown"
  result: 'scheduled' | 'discarded';
  discard_reason?: string;
  cached: boolean;
}

export interface DebugLocationFilteringEntry {
  message: {
    timestamp: Date;
    content: string;
    link: string;
  };
  event_type: string;
  ai_prompt: string;
  ai_response: string;
  extracted_venue: string;
  extracted_address: string;
  /** Which configured location this fell in; empty when none matched */
  matched_location: string;
  confidence: number;
  result: 'located' | 'discarded';
  discard_reason?: string;
  cached: boolean;
}

export interface DebugInterestMatchingEntry {
  message: {
    timestamp: Date;
    content: string;
    link: string;
  };
  event_type: string;
  start_datetime: Date;
  ai_prompt: string;
  ai_response: string;
  interest_matches: Array<{
    interest: string;
    confidence: number;
  }>;
  result: 'matched' | 'discarded';
  cached: boolean;
}

export interface DebugEventDescriptionEntry {
  message: {
    timestamp: Date;
    content: string;
    link: string;
  };
  event_type: string;
  start_datetime: Date;
  interest_matches: Array<{
    interest: string;
    confidence: number;
  }>;
  ai_prompt: string;
  ai_response: string;
  extracted_title: string;
  extracted_summary: string;
  extraction_success: boolean;
  cached: boolean;
}
