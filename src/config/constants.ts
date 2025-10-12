/**
 * Configuration constants with rationale
 *
 * This file contains magic numbers and their explanations to improve maintainability.
 */

/**
 * Groups generate more noise than channels due to user discussions,
 * so we fetch more messages to ensure we don't miss actual event announcements.
 * Value of 1.5 means 50% more messages for groups vs channels.
 */
export const GROUP_MESSAGE_MULTIPLIER = 1.5;

/**
 * Brief delay to ensure Telegram's internal event loop completes before disconnect.
 * Prevents harmless but noisy timeout errors in the console.
 * 100ms is sufficient for most cleanup operations.
 */
export const TELEGRAM_DISCONNECT_DELAY_MS = 100;

/**
 * Maximum number of retry attempts for OpenAI API calls when rate limited.
 * 3 retries provides good balance between resilience and fast failure.
 */
export const OPENAI_MAX_RETRIES = 3;

/**
 * Initial backoff delay in milliseconds for OpenAI rate limit retries.
 * Uses exponential backoff: 2s, 4s, 8s for retries.
 * 2000ms (2 seconds) is a reasonable starting point for rate limit recovery.
 */
export const OPENAI_INITIAL_BACKOFF_MS = 2000;
