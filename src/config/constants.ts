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
