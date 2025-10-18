import { TelegramMessage, InterestMatch, EventType } from '../entities';

/**
 * Domain types for debug entries
 * These types are used by domain services to collect debug information
 * without depending on the presentation layer or specific AI implementation
 */

export interface DebugEventDetectionEntry {
  messageLink: string;
  isEvent: boolean;
  cached: boolean;
  prompt?: string;
  aiResponse?: string;
}

export interface DebugTypeClassificationEntry {
  message: TelegramMessage;
  ai_prompt: string;
  ai_response: string;
  result: EventType | 'discarded';
  substep: '4_classification';
  cached: boolean;
}

export interface DebugScheduleFilteringEntry {
  message: TelegramMessage;
  event_type: string;
  ai_prompt: string;
  ai_response: string;
  extracted_datetime: string;
  result: 'scheduled' | 'discarded';
  discard_reason?: string;
  cached: boolean;
}

export interface DebugInterestMatchingEntry {
  message: TelegramMessage;
  event_type: string;
  start_datetime: string;
  ai_prompt: string;
  ai_response: string;
  interests_matched: string[];
  interest_matches?: InterestMatch[];
  result: 'matched' | 'discarded';
  cached: boolean;
}

export interface DebugEventDescriptionEntry {
  message: TelegramMessage;
  event_type: string;
  start_datetime: string;
  interests_matched: string[];
  ai_prompt: string;
  ai_response: string;
  extracted_title: string;
  extracted_summary: string;
  extraction_success: boolean;
  cached: boolean;
}
