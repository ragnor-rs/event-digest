import fs from 'fs';
import path from 'path';

import { TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { Dialog } from 'telegram/tl/custom/dialog';

import { ICache, IMessageSource } from '../domain/interfaces';
import { SourceMessage } from '../domain/entities';
import { Logger } from '../shared/logger';
import { promptForPassword, promptForCode } from '../shared/readline-helper';
import { Username } from 'telegram/define';

const TELEGRAM_DISCONNECT_DELAY_MS = 100; // ms to wait before disconnect

export class TelegramClient implements IMessageSource {
  private client: GramJSClient;
  private session: StringSession;
  private sessionFile: string;
  private cache: ICache;
  private logger: Logger;
  private dialogs: Dialog[] | null = null;

  constructor(cache: ICache, logger: Logger) {
    this.cache = cache;
    this.logger = logger;

    const apiIdStr = process.env.TELEGRAM_API_ID;
    if (!apiIdStr) {
      throw new Error('TELEGRAM_API_ID environment variable is not set');
    }

    const apiId = parseInt(apiIdStr);
    if (isNaN(apiId)) {
      throw new Error(`TELEGRAM_API_ID must be a valid number, got: "${apiIdStr}"`);
    }

    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiHash) {
      throw new Error('TELEGRAM_API_HASH environment variable is not set');
    }

    this.sessionFile = path.join(process.cwd(), '.telegram-session');
    const savedSession = this.loadSession();
    this.session = new StringSession(savedSession);
    this.client = new GramJSClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
    });
  }

  private loadSession(): string {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const sessionData = fs.readFileSync(this.sessionFile, 'utf-8').trim();
        if (sessionData) {
          this.logger.log('Using saved Telegram session');
          return sessionData;
        }
      }
    } catch {
      this.logger.log('No valid saved session found, will authenticate');
    }
    return '';
  }

  private saveSession(): void {
    try {
      const sessionString = this.session.save() as string;
      if (sessionString) {
        fs.writeFileSync(this.sessionFile, sessionString);
        this.logger.log('Telegram session saved');
      }
    } catch (error) {
      this.logger.error('Failed to save Telegram session', error);
    }
  }

  async connect(): Promise<void> {
    const phoneNumber = process.env.TELEGRAM_PHONE_NUMBER;
    if (!phoneNumber) {
      throw new Error('TELEGRAM_PHONE_NUMBER environment variable is not set');
    }

    await this.client.start({
      phoneNumber: async () => phoneNumber,
      password: promptForPassword,
      phoneCode: promptForCode,
      onError: (err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.error('Telegram authentication error:', errorMessage);
      },
    });

    // Always save session after successful connection to ensure it's persisted
    this.saveSession();
    this.logger.log('Connected to Telegram');
  }

  /**
   * Loads all user dialogs once per program run to avoid flood wait
   */
  private async loadDialogs(): Promise<Dialog[]> {
    if (this.dialogs === null) {
      const dialogList = await this.client.getDialogs({ limit: 200 });
      this.dialogs = Array.from(dialogList);
    }
    return this.dialogs;
  }

  /**
   * Searches for a channel or group by display name among user's dialogs
   * Returns entity and actual username/ID for the first match (case-insensitive)
   */
  private async findEntityByDisplayName(
    searchName: string,
    sourceType: 'group' | 'channel'
  ): Promise<{ entity: Api.TypeEntityLike; actualName: string; displayName: string | undefined } | null> {
    try {
      // Load dialogs (cached after first call to avoid flood wait)
      const dialogs = await this.loadDialogs();

      const searchLower = searchName.toLowerCase();

      for (const dialog of dialogs) {
        const entity = dialog.entity;

        // Check if entity type matches what we're looking for
        if (!entity) continue;

        if (sourceType === 'channel' && !dialog.isChannel) continue;
        if (sourceType === 'group' && !dialog.isGroup) continue;

        // Get the display name (title)
        const title = dialog.title?.toLowerCase() || '';

        // Check if display name contains the search term
        if (title.includes(searchLower)) {
          // Get actual username or use ID
          let actualName: string;
          if (entity instanceof Api.Channel) {
            actualName = entity.username || `c/${entity.id}`;
          } else {
            actualName = `c/${entity.id}`;
          }

          let displayName: string | undefined = dialog.title

          return { entity, actualName, displayName };
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Error searching for ${sourceType} by name`, error);
      return null;
    }
  }

  /**
   * Fetches messages from a Telegram group or channel
   *
   * Supported name formats:
   *   - @username: Direct lookup by username (requires @ prefix, fastest for public channels/groups)
   *   - "Display Name": Searches through joined dialogs (works for both public and private)
   */
  private async fetchMessagesFromSource(
    sourceName: string,
    sourceType: 'group' | 'channel',
    limit: number
  ): Promise<SourceMessage[]> {
    this.logger.verbose(`  Fetching messages from ${sourceType} ${sourceName}...`);

    // Check if name starts with @ symbol (username) or not (display name)
    const isUsername = sourceName.startsWith('@');

    let entity: Api.TypeEntityLike;
    let actualSourceName: String;
  
    // Determine how to fetch the entity
    if (isUsername) {
      actualSourceName = sourceName.slice(1)
      // Username provided, use direct lookup
      entity = await this.client.getEntity(actualSourceName as Username);
    } else {
      // Display name provided, search by display name
      this.logger.verbose(`    Searching by display name...`);
      const found = await this.findEntityByDisplayName(sourceName, sourceType);
      if (found) {
        entity = found.entity;
        actualSourceName = found.actualName;
        this.logger.verbose(`    Using ${sourceType}: "${found.displayName || sourceName}" → ${actualSourceName}`);
      } else {
        this.logger.verbose(`    Display name not found`);
        return [];
      }
    }

    const cacheKey = `${sourceType}:${actualSourceName}:${limit}`;

    // Get cached messages
    const cachedMessages = this.cache.getCachedMessages(cacheKey) || [];

    try {
      if (cachedMessages.length > 0) {
        this.logger.verbose(`    Cache contains ${cachedMessages.length} messages`);
      }

      // Get the last cached message ID to fetch only newer messages
      let minId: number | undefined;
      if (cachedMessages.length > 0) {
        const lastCachedLink = cachedMessages[cachedMessages.length - 1].link;
        const lastCachedId = parseInt(lastCachedLink.split('/').pop() || '0');
        minId = lastCachedId;
      }

      const telegramMessages = await this.client.getMessages(entity, {
        limit: limit,
        minId: minId,
      });

      const newMessages: SourceMessage[] = [];
      for (const msg of telegramMessages) {
        if (msg.message) {
          newMessages.push({
            timestamp: new Date(msg.date * 1000).toISOString(),
            content: msg.message,
            link: `https://t.me/${actualSourceName}/${msg.id}`,
          });
        }
      }

      this.logger.verbose(`    Fetched ${newMessages.length} new messages`);

      // Combine cached messages with new messages efficiently
      // Use Set for O(1) lookup to avoid duplicates
      const seenLinks = new Set(cachedMessages.map((m) => m.link));
      const uniqueNewMessages = newMessages.filter((msg) => !seenLinks.has(msg.link));

      // Combine arrays efficiently
      const allMessages = cachedMessages.concat(uniqueNewMessages);

      // Sort by timestamp (pre-parse timestamps for efficiency)
      allMessages.sort((a, b) => {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });

      // Take the most recent 'limit' messages as final result
      const finalMessages = allMessages.slice(-limit);

      this.logger.verbose(`    Total messages: ${finalMessages.length}`);

      // Update cache with all unique messages for future runs
      this.cache.cacheMessages(cacheKey, allMessages);

      return finalMessages;
    } catch (error) {
      this.logger.error(`Error fetching from ${sourceType} ${sourceName}`, error);

      // If we have cached messages, return them with a warning
      if (cachedMessages.length > 0) {
        this.logger.log(`  Returning ${cachedMessages.length} cached messages due to fetch error`);
        return cachedMessages.slice(-limit);
      }

      // If no cached messages and fetch failed, throw error
      throw new Error(
        `Failed to fetch messages from ${sourceType} ${sourceName} and no cached messages available: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async fetchMessages(
    groupsToParse: string[],
    channelsToParse: string[],
    maxGroupMessages: number,
    maxChannelMessages: number
  ): Promise<SourceMessage[]> {
    const allMessages: SourceMessage[] = [];

    // Process groups with higher message limit
    for (const groupName of groupsToParse) {
      const messages = await this.fetchMessagesFromSource(groupName, 'group', maxGroupMessages);
      allMessages.push(...messages);
    }

    // Process channels with separate limit
    for (const channelName of channelsToParse) {
      const messages = await this.fetchMessagesFromSource(channelName, 'channel', maxChannelMessages);
      allMessages.push(...messages);
    }

    const sortedMessages = allMessages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    this.logger.log(`  Fetched ${sortedMessages.length} total messages`);

    return sortedMessages;
  }

  async disconnect(): Promise<void> {
    try {
      // Give a brief moment for any ongoing operations to complete
      await new Promise((resolve) => setTimeout(resolve, TELEGRAM_DISCONNECT_DELAY_MS));
      await this.client.disconnect();
      await this.client.destroy();
      this.logger.log('Disconnected from Telegram');
    } catch (error) {
      // Log errors for diagnostics, but don't throw as they're often harmless timeouts from _updateLoop
      this.logger.verbose(
        `Disconnect error (likely harmless timeout): ${error instanceof Error ? error.message : String(error)}`
      );
      this.logger.log('Disconnection completed');
    }
  }
}
