/**
 * Shared debug entry types
 * These types use primitive types to avoid dependencies on domain entities
 * They are used by domain services to collect debug information
 */

export interface DebugEventDetectionEntry {
  messageLink: string;
  isEvent: boolean;
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
  result: 'offline' | 'online' | 'hybrid' | 'discarded';
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
