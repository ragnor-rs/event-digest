import { REASONING_EFFORTS, ReasoningEffort } from '../domain/interfaces';

import { Config } from './types';

type ReasoningEffortField =
  | 'reasoningEffort'
  | 'eventDetectionReasoningEffort'
  | 'eventClassificationReasoningEffort'
  | 'scheduleExtractionReasoningEffort'
  | 'interestMatchingReasoningEffort'
  | 'eventDescriptionReasoningEffort';

/** Maps --*-reasoning-effort flags to their Config field */
const REASONING_EFFORT_OPTIONS: Record<string, ReasoningEffortField> = {
  '--reasoning-effort': 'reasoningEffort',
  '--event-detection-reasoning-effort': 'eventDetectionReasoningEffort',
  '--event-classification-reasoning-effort': 'eventClassificationReasoningEffort',
  '--schedule-extraction-reasoning-effort': 'scheduleExtractionReasoningEffort',
  '--interest-matching-reasoning-effort': 'interestMatchingReasoningEffort',
  '--event-description-reasoning-effort': 'eventDescriptionReasoningEffort',
};

const VALID_OPTIONS = [
  '--config',
  '--groups',
  '--channels',
  '--interests',
  '--timeslots',
  '--max-messages',
  '--max-group-messages',
  '--max-channel-messages',
  '--write-debug-files',
  '--skip-online-events',
  '--verbose-logging',
  '--include-events-without-time',
  '--deduplicate-events',
  '--min-event-detection-confidence',
  '--min-event-classification-confidence',
  '--min-interest-confidence',
  '--event-detection-batch-size',
  '--event-classification-batch-size',
  '--schedule-extraction-batch-size',
  '--event-description-batch-size',
  '--send-events-recipient',
  '--send-events-batch-size',
  ...Object.keys(REASONING_EFFORT_OPTIONS),
];

export function parseCommandLineArgs(args: string[]): Partial<Config> {
  const config: Partial<Config> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    // Skip --config argument as it's handled separately
    if (key === '--config' || key.startsWith('--config=')) {
      i -= 1; // Adjust since --config= doesn't consume next arg
      continue;
    }

    // Check if option is recognized
    if (!VALID_OPTIONS.includes(key)) {
      const validOptionsStr = VALID_OPTIONS.filter((opt) => opt !== '--config').join('\n  ');
      throw new Error(
        `Unrecognized option '${key}'\n\nValid options:\n  ${validOptionsStr}\n\nSee README.md for usage examples.`
      );
    }

    // All --*-reasoning-effort flags parse identically
    const effortField = REASONING_EFFORT_OPTIONS[key];
    if (effortField) {
      const effort = value.trim().toLowerCase();
      if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
        throw new Error(
          `Invalid value for ${key}: "${value}". Must be one of: ${REASONING_EFFORTS.join(', ')}`
        );
      }
      config[effortField] = effort as ReasoningEffort;
      continue;
    }

    switch (key) {
      case '--groups':
        config.groupsToParse = value.split(',').map((s) => s.trim());
        break;
      case '--channels':
        config.channelsToParse = value.split(',').map((s) => s.trim());
        break;
      case '--interests':
        config.userInterests = value.split(',').map((s) => s.trim());
        break;
      case '--timeslots':
        config.weeklyTimeslots = value.split(',').map((s) => s.trim());
        break;
      case '--max-messages': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(`Invalid value for --max-messages: "${value}". Must be a positive integer.`);
        }
        config.maxInputMessages = parsed;
        break;
      }
      case '--max-group-messages': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(`Invalid value for --max-group-messages: "${value}". Must be a positive integer.`);
        }
        config.maxGroupMessages = parsed;
        break;
      }
      case '--max-channel-messages': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(`Invalid value for --max-channel-messages: "${value}". Must be a positive integer.`);
        }
        config.maxChannelMessages = parsed;
        break;
      }
      case '--write-debug-files':
        config.writeDebugFiles = value.toLowerCase() === 'true';
        break;
      case '--skip-online-events':
        config.skipOnlineEvents = value.toLowerCase() === 'true';
        break;
      case '--verbose-logging':
        config.verboseLogging = value.toLowerCase() === 'true';
        break;
      case '--include-events-without-time':
        config.includeEventsWithoutTime = value.toLowerCase() === 'true';
        break;
      case '--deduplicate-events':
        config.deduplicateEvents = value.toLowerCase() === 'true';
        break;
      case '--min-event-detection-confidence': {
        const parsed = parseFloat(value);
        if (isNaN(parsed) || parsed < 0 || parsed > 1) {
          throw new Error(`Invalid value for --min-event-detection-confidence: "${value}". Must be between 0.0 and 1.0.`);
        }
        config.minEventDetectionConfidence = parsed;
        break;
      }
      case '--min-event-classification-confidence': {
        const parsed = parseFloat(value);
        if (isNaN(parsed) || parsed < 0 || parsed > 1) {
          throw new Error(`Invalid value for --min-event-classification-confidence: "${value}". Must be between 0.0 and 1.0.`);
        }
        config.minEventClassificationConfidence = parsed;
        break;
      }
      case '--min-interest-confidence': {
        const parsed = parseFloat(value);
        if (isNaN(parsed) || parsed < 0 || parsed > 1) {
          throw new Error(`Invalid value for --min-interest-confidence: "${value}". Must be between 0.0 and 1.0.`);
        }
        config.minInterestConfidence = parsed;
        break;
      }
      case '--event-detection-batch-size': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(
            `Invalid value for --event-detection-batch-size: "${value}". Must be a positive integer.`
          );
        }
        config.eventDetectionBatchSize = parsed;
        break;
      }
      case '--event-classification-batch-size': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(
            `Invalid value for --event-classification-batch-size: "${value}". Must be a positive integer.`
          );
        }
        config.eventClassificationBatchSize = parsed;
        break;
      }
      case '--schedule-extraction-batch-size': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(
            `Invalid value for --schedule-extraction-batch-size: "${value}". Must be a positive integer.`
          );
        }
        config.scheduleExtractionBatchSize = parsed;
        break;
      }
      case '--event-description-batch-size': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(
            `Invalid value for --event-description-batch-size: "${value}". Must be a positive integer.`
          );
        }
        config.eventDescriptionBatchSize = parsed;
        break;
      }
      case '--send-events-recipient':
        config.sendEventsRecipient = value.trim();
        break;
      case '--send-events-batch-size': {
        const parsed = parseInt(value);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error(`Invalid value for --send-events-batch-size: "${value}". Must be a positive integer.`);
        }
        config.sendEventsBatchSize = parsed;
        break;
      }
    }
  }

  return config;
}
