import { TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { TelegramMessage } from '../domain/entities';
import { Config } from '../config/types';
import fs from 'fs';
import path from 'path';
import { Cache } from './cache';
import { promptForPassword, promptForCode } from '../shared/readline-helper';

export class TelegramClient {
  private client: GramJSClient;
  private session: StringSession;
  private sessionFile: string;
  private isNewSession: boolean;
  private cache: Cache;

  constructor(cache: Cache) {
    this.cache = cache;
    const apiIdStr = process.env.TELEGRAM_API_ID!;
    const apiId = parseInt(apiIdStr);
    if (isNaN(apiId)) {
      throw new Error(`TELEGRAM_API_ID must be a valid number, got: "${apiIdStr}"`);
    }
    const apiHash = process.env.TELEGRAM_API_HASH!;

    this.sessionFile = path.join(process.cwd(), '.telegram-session');
    const savedSession = this.loadSession();
    this.session = new StringSession(savedSession);
    this.isNewSession = !savedSession;
    this.client = new GramJSClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
    });
  }

  private loadSession(): string {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const sessionData = fs.readFileSync(this.sessionFile, 'utf-8').trim();
        if (sessionData) {
          console.log('Using saved Telegram session');
          return sessionData;
        }
      }
    } catch {
      console.log('No valid saved session found, will authenticate');
    }
    return '';
  }

  private saveSession(): void {
    try {
      const sessionString = this.session.save() as string;
      if (sessionString) {
        fs.writeFileSync(this.sessionFile, sessionString);
        console.log('Telegram session saved');
      }
    } catch (error) {
      console.error('Failed to save Telegram session:', error);
    }
  }

  async connect(): Promise<void> {
    await this.client.start({
      phoneNumber: async () => process.env.TELEGRAM_PHONE_NUMBER!,
      password: promptForPassword,
      phoneCode: promptForCode,
      onError: (err: any) => console.log(err),
    });

    // Save session only if it's a new session
    if (this.isNewSession) {
      this.saveSession();
    }
    console.log('Connected to Telegram');
  }

  private async fetchMessagesFromSource(
    sourceName: string,
    sourceType: 'group' | 'channel',
    limit: number,
    config: Config
  ): Promise<TelegramMessage[]> {
    const cacheKey = `${sourceType}:${sourceName}`;

    // Get cached messages
    const cachedMessages = this.cache.getCachedMessages(cacheKey) || [];

    try {
      if (config.verboseLogging) {
        console.log(`  Fetching messages from ${sourceType} ${sourceName}...`);
        if (cachedMessages.length > 0) {
          console.log(`    Cache contains ${cachedMessages.length} messages`);
        }
      }

      const entity = await this.client.getEntity(sourceName);

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

      const newMessages: TelegramMessage[] = [];
      for (const msg of telegramMessages) {
        if (msg.message) {
          newMessages.push({
            timestamp: new Date(msg.date * 1000).toISOString(),
            content: msg.message,
            link: `https://t.me/${sourceName}/${msg.id}`,
          });
        }
      }

      if (config.verboseLogging) {
        console.log(`    Fetched ${newMessages.length} new messages`);
      }

      // Combine cached messages with new messages
      const allMessages = [...cachedMessages, ...newMessages];

      // Remove duplicates by link (new messages override cached)
      const uniqueMessages = Array.from(new Map(allMessages.map((msg) => [msg.link, msg])).values()).sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Take the most recent 'limit' messages as final result
      const finalMessages = uniqueMessages.slice(-limit);

      if (config.verboseLogging) {
        console.log(`    Total messages: ${finalMessages.length}`);
      }

      // Update cache with all unique messages for future runs
      this.cache.cacheMessages(cacheKey, uniqueMessages);

      return finalMessages;
    } catch (error) {
      console.error(`Error fetching from ${sourceType} ${sourceName}:`, error);
      // Return cached messages if fetch fails
      return cachedMessages;
    }
  }

  async fetchMessages(config: Config): Promise<TelegramMessage[]> {
    console.log('Fetching messages from Telegram...');

    const allMessages: TelegramMessage[] = [];

    // Process groups with higher message limit
    for (const groupName of config.groupsToParse) {
      const messages = await this.fetchMessagesFromSource(groupName, 'group', config.maxGroupMessages, config);
      allMessages.push(...messages);
    }

    // Process channels with separate limit
    for (const channelName of config.channelsToParse) {
      const messages = await this.fetchMessagesFromSource(channelName, 'channel', config.maxChannelMessages, config);
      allMessages.push(...messages);
    }

    const sortedMessages = allMessages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    console.log(`  Fetched ${sortedMessages.length} total messages`);

    return sortedMessages;
  }

  async disconnect(): Promise<void> {
    try {
      // Give a brief moment for any ongoing operations to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.client.disconnect();
      await this.client.destroy();
      console.log('Disconnected from Telegram');
    } catch {
      // Ignore disconnect errors as they're often harmless timeouts from _updateLoop
      console.log('Disconnection completed (ignoring timeout errors)');
    }
  }
}
