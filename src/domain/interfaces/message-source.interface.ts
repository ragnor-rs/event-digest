import { TelegramMessage } from '../entities';

/**
 * Interface for message source operations (e.g., Telegram, Slack, Discord)
 * This allows the application layer to remain independent of specific messaging platforms
 */
export interface IMessageSource {
  /**
   * Connect to the message source
   */
  connect(): Promise<void>;

  /**
   * Fetch messages from configured groups and channels
   * @param groupsToParse List of group identifiers to fetch from
   * @param channelsToParse List of channel identifiers to fetch from
   * @param maxGroupMessages Maximum messages to fetch per group
   * @param maxChannelMessages Maximum messages to fetch per channel
   * @returns Array of telegram messages
   */
  fetchMessages(
    groupsToParse: string[],
    channelsToParse: string[],
    maxGroupMessages: number,
    maxChannelMessages: number
  ): Promise<TelegramMessage[]>;

  /**
   * Disconnect from the message source
   */
  disconnect(): Promise<void>;
}
