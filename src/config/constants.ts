/**
 * Configuration constants with rationale
 *
 * This file contains magic numbers and their explanations to improve maintainability.
 */

/**
 * Groups generate more noise than channels due to user discussions,
 * so we fetch more messages to ensure we don't miss actual event announcements.
 * Value of 4.0 reflects the 4:1 ratio observed in real-world usage.
 */
export const GROUP_MESSAGE_MULTIPLIER = 4.0;
