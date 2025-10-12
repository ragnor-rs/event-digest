import { Config } from './types';

const VALID_OPTIONS = [
  '--config',
  '--groups',
  '--channels',
  '--interests',
  '--timeslots',
  '--last-timestamp',
  '--max-messages',
  '--max-group-messages',
  '--max-channel-messages',
  '--write-debug-files',
  '--skip-online-events',
  '--verbose-logging',
  '--min-interest-confidence',
  '--gpt-batch-size-event-detection',
  '--gpt-batch-size-event-classification',
  '--gpt-batch-size-schedule-extraction',
  '--gpt-batch-size-event-description'
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
      const validOptionsStr = VALID_OPTIONS.filter(opt => opt !== '--config').join('\n  ');
      throw new Error(`Unrecognized option '${key}'\n\nValid options:\n  ${validOptionsStr}\n\nSee README.md for usage examples.`);
    }

    switch (key) {
      case '--groups':
        config.groupsToParse = value.split(',').map(s => s.trim());
        break;
      case '--channels':
        config.channelsToParse = value.split(',').map(s => s.trim());
        break;
      case '--interests':
        config.userInterests = value.split(',').map(s => s.trim());
        break;
      case '--timeslots':
        config.weeklyTimeslots = value.split(',').map(s => s.trim());
        break;
      case '--last-timestamp':
        config.lastGenerationTimestamp = value;
        break;
      case '--max-messages':
        config.maxInputMessages = parseInt(value);
        break;
      case '--max-group-messages':
        config.maxGroupMessages = parseInt(value);
        break;
      case '--max-channel-messages':
        config.maxChannelMessages = parseInt(value);
        break;
      case '--write-debug-files':
        config.writeDebugFiles = value.toLowerCase() === 'true';
        break;
      case '--skip-online-events':
        config.skipOnlineEvents = value.toLowerCase() === 'true';
        break;
      case '--verbose-logging':
        config.verboseLogging = value.toLowerCase() === 'true';
        break;
      case '--min-interest-confidence':
        config.minInterestConfidence = parseFloat(value);
        break;
      case '--gpt-batch-size-event-detection':
        config.gptBatchSizeEventDetection = parseInt(value);
        break;
      case '--gpt-batch-size-event-classification':
        config.gptBatchSizeEventClassification = parseInt(value);
        break;
      case '--gpt-batch-size-schedule-extraction':
        config.gptBatchSizeScheduleExtraction = parseInt(value);
        break;
      case '--gpt-batch-size-event-description':
        config.gptBatchSizeEventDescription = parseInt(value);
        break;
    }
  }

  return config;
}
