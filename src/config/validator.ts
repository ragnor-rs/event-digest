import { GROUP_MESSAGE_MULTIPLIER } from './constants';
import { DEFAULT_CONFIG } from './defaults';
import { Config } from './types';

export function validateAndCompleteConfig(config: Partial<Config>): Config {
  // Track which values were provided vs defaulted
  const providedMaxGroupMessages = config.maxGroupMessages !== undefined;
  const providedMaxChannelMessages = config.maxChannelMessages !== undefined;
  const providedSkipOnlineEvents = config.skipOnlineEvents !== undefined;
  const providedWriteDebugFiles = config.writeDebugFiles !== undefined;
  const providedVerboseLogging = config.verboseLogging !== undefined;
  const providedMinInterestConfidence = config.minInterestConfidence !== undefined;
  const providedEventMessageCues = config.eventMessageCues !== undefined;
  const providedGptBatchSizeEventDetection = config.gptBatchSizeEventDetection !== undefined;
  const providedGptBatchSizeEventClassification = config.gptBatchSizeEventClassification !== undefined;
  const providedGptBatchSizeScheduleExtraction = config.gptBatchSizeScheduleExtraction !== undefined;
  const providedGptBatchSizeEventDescription = config.gptBatchSizeEventDescription !== undefined;
  const providedEventDetectionPrompt = config.eventDetectionPrompt !== undefined;
  const providedInterestMatchingPrompt = config.interestMatchingPrompt !== undefined;
  const providedEventTypeClassificationPrompt = config.eventTypeClassificationPrompt !== undefined;
  const providedScheduleExtractionPrompt = config.scheduleExtractionPrompt !== undefined;
  const providedEventDescriptionPrompt = config.eventDescriptionPrompt !== undefined;

  // Set defaults for separate limits
  if (config.maxGroupMessages === undefined && config.maxChannelMessages === undefined) {
    // If neither is specified, use legacy maxInputMessages or defaults
    const legacyLimit = config.maxInputMessages || DEFAULT_CONFIG.maxGroupMessages;
    config.maxGroupMessages = Math.floor(legacyLimit * GROUP_MESSAGE_MULTIPLIER);
    config.maxChannelMessages = legacyLimit;
  } else {
    // Set individual defaults if only one is specified
    if (config.maxGroupMessages === undefined) {
      config.maxGroupMessages = DEFAULT_CONFIG.maxGroupMessages;
    }
    if (config.maxChannelMessages === undefined) {
      config.maxChannelMessages = DEFAULT_CONFIG.maxChannelMessages;
    }
  }

  // Apply defaults for all other fields
  if (!config.eventMessageCues) {
    config.eventMessageCues = DEFAULT_CONFIG.eventMessageCues;
  }

  if (config.skipOnlineEvents === undefined) {
    config.skipOnlineEvents = DEFAULT_CONFIG.skipOnlineEvents;
  }

  if (config.writeDebugFiles === undefined) {
    config.writeDebugFiles = DEFAULT_CONFIG.writeDebugFiles;
  }

  if (config.verboseLogging === undefined) {
    config.verboseLogging = DEFAULT_CONFIG.verboseLogging;
  }

  if (config.minInterestConfidence === undefined) {
    config.minInterestConfidence = DEFAULT_CONFIG.minInterestConfidence;
  }

  // Set default GPT batch sizes
  if (config.gptBatchSizeEventDetection === undefined) {
    config.gptBatchSizeEventDetection = DEFAULT_CONFIG.gptBatchSizeEventDetection;
  }
  if (config.gptBatchSizeEventClassification === undefined) {
    config.gptBatchSizeEventClassification = DEFAULT_CONFIG.gptBatchSizeEventClassification;
  }
  if (config.gptBatchSizeScheduleExtraction === undefined) {
    config.gptBatchSizeScheduleExtraction = DEFAULT_CONFIG.gptBatchSizeScheduleExtraction;
  }
  if (config.gptBatchSizeEventDescription === undefined) {
    config.gptBatchSizeEventDescription = DEFAULT_CONFIG.gptBatchSizeEventDescription;
  }

  // Set default prompts
  if (!config.eventDetectionPrompt) {
    config.eventDetectionPrompt = DEFAULT_CONFIG.eventDetectionPrompt;
  }

  if (!config.interestMatchingPrompt) {
    config.interestMatchingPrompt = DEFAULT_CONFIG.interestMatchingPrompt;
  }

  if (!config.eventTypeClassificationPrompt) {
    config.eventTypeClassificationPrompt = DEFAULT_CONFIG.eventTypeClassificationPrompt;
  }

  if (!config.scheduleExtractionPrompt) {
    config.scheduleExtractionPrompt = DEFAULT_CONFIG.scheduleExtractionPrompt;
  }

  if (!config.eventDescriptionPrompt) {
    config.eventDescriptionPrompt = DEFAULT_CONFIG.eventDescriptionPrompt;
  }

  // Validate required fields exist and are non-empty
  if (!config.groupsToParse || config.groupsToParse.length === 0) {
    throw new Error('groupsToParse must contain at least one group');
  }
  if (!config.channelsToParse || config.channelsToParse.length === 0) {
    throw new Error('channelsToParse must contain at least one channel');
  }
  if (!config.userInterests || config.userInterests.length === 0) {
    throw new Error('userInterests must contain at least one interest');
  }
  if (!config.weeklyTimeslots || config.weeklyTimeslots.length === 0) {
    throw new Error('weeklyTimeslots must contain at least one timeslot');
  }

  // Validate timeslot format
  const timeslotRegex = /^[0-6]\s+\d{2}:\d{2}$/;
  const invalidSlots = config.weeklyTimeslots.filter((slot) => !timeslotRegex.test(slot));
  if (invalidSlots.length > 0) {
    throw new Error(
      `Invalid timeslot format: ${invalidSlots.join(', ')}. Expected format: "DAY HH:MM" where DAY is 0-6 (e.g., "6 14:00" for Saturday at 2 PM)`
    );
  }

  // Log final configuration
  const finalConfig = config as Config;
  console.log('Configuration loaded successfully:');
  console.log(`  groupsToParse: ${finalConfig.groupsToParse.length} specified`);
  console.log(`  channelsToParse: ${finalConfig.channelsToParse.length} specified`);
  console.log(`  userInterests: ${finalConfig.userInterests.length} specified`);
  console.log(`  weeklyTimeslots: ${finalConfig.weeklyTimeslots.length} specified`);
  console.log(
    `  maxGroupMessages: ${finalConfig.maxGroupMessages}${!providedMaxGroupMessages && !config.maxInputMessages ? ' (default)' : ''}`
  );
  console.log(
    `  maxChannelMessages: ${finalConfig.maxChannelMessages}${!providedMaxChannelMessages && !config.maxInputMessages ? ' (default)' : ''}`
  );
  console.log(`  skipOnlineEvents: ${finalConfig.skipOnlineEvents}${!providedSkipOnlineEvents ? ' (default)' : ''}`);
  console.log(`  writeDebugFiles: ${finalConfig.writeDebugFiles}${!providedWriteDebugFiles ? ' (default)' : ''}`);
  console.log(`  verboseLogging: ${finalConfig.verboseLogging}${!providedVerboseLogging ? ' (default)' : ''}`);
  console.log(
    `  minInterestConfidence: ${finalConfig.minInterestConfidence}${!providedMinInterestConfidence ? ' (default)' : ''}`
  );
  console.log(
    `  gptBatchSizeEventDetection: ${finalConfig.gptBatchSizeEventDetection}${!providedGptBatchSizeEventDetection ? ' (default)' : ''}`
  );
  console.log(
    `  gptBatchSizeEventClassification: ${finalConfig.gptBatchSizeEventClassification}${!providedGptBatchSizeEventClassification ? ' (default)' : ''}`
  );
  console.log(
    `  gptBatchSizeScheduleExtraction: ${finalConfig.gptBatchSizeScheduleExtraction}${!providedGptBatchSizeScheduleExtraction ? ' (default)' : ''}`
  );
  console.log(
    `  gptBatchSizeEventDescription: ${finalConfig.gptBatchSizeEventDescription}${!providedGptBatchSizeEventDescription ? ' (default)' : ''}`
  );
  console.log(`  lastGenerationTimestamp: ${finalConfig.lastGenerationTimestamp || 'not set'}`);
  console.log(
    `  eventMessageCues: ${Object.values(finalConfig.eventMessageCues).flat().length} cues${!providedEventMessageCues ? ' (default)' : ''}`
  );
  console.log(
    `  eventDetectionPrompt: ${finalConfig.eventDetectionPrompt!.length} chars${!providedEventDetectionPrompt ? ' (default)' : ''}`
  );
  console.log(
    `  interestMatchingPrompt: ${finalConfig.interestMatchingPrompt!.length} chars${!providedInterestMatchingPrompt ? ' (default)' : ''}`
  );
  console.log(
    `  eventTypeClassificationPrompt: ${finalConfig.eventTypeClassificationPrompt!.length} chars${!providedEventTypeClassificationPrompt ? ' (default)' : ''}`
  );
  console.log(
    `  scheduleExtractionPrompt: ${finalConfig.scheduleExtractionPrompt!.length} chars${!providedScheduleExtractionPrompt ? ' (default)' : ''}`
  );
  console.log(
    `  eventDescriptionPrompt: ${finalConfig.eventDescriptionPrompt!.length} chars${!providedEventDescriptionPrompt ? ' (default)' : ''}`
  );
  console.log('');

  return finalConfig;
}
