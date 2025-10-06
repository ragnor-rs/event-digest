import { TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { TelegramMessage, Config } from './types';
import { parse } from 'date-fns';
import fs from 'fs';
import path from 'path';
import { Cache } from './cache';

export class TelegramClient {
  private client: GramJSClient;
  private session: StringSession;
  private sessionFile: string;
  private isNewSession: boolean;
  private cache: Cache;

  constructor(cache: Cache) {
    this.cache = cache;
    const apiId = parseInt(process.env.TELEGRAM_API_ID!);
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
    } catch (error) {
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
      password: async () => {
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        return new Promise((resolve) => {
          rl.stdoutMuted = true;
          rl.question('Password? ', (answer: string) => {
            rl.stdoutMuted = false;
            rl.output.write('\n');
            rl.close();
            resolve(answer);
          });
          rl._writeToOutput = (stringToWrite: string) => {
            if (rl.stdoutMuted && stringToWrite !== 'Password? ') {
              rl.output.write('*');
            } else {
              rl.output.write(stringToWrite);
            }
          };
        });
      },
      phoneCode: async () => {
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        return new Promise((resolve) => {
          rl.stdoutMuted = true;
          rl.question('Verification Code? ', (answer: string) => {
            rl.stdoutMuted = false;
            rl.output.write('\n');
            rl.close();
            resolve(answer);
          });
          rl._writeToOutput = (stringToWrite: string) => {
            if (rl.stdoutMuted && stringToWrite !== 'Verification Code? ') {
              rl.output.write('*');
            } else {
              rl.output.write(stringToWrite);
            }
          };
        });
      },
      onError: (err: any) => console.log(err),
    });
    
    // Save session only if it's a new session
    if (this.isNewSession) {
      this.saveSession();
    }
    console.log('Connected to Telegram');
  }

  private async fetchMessagesFromSource(sourceName: string, sourceType: 'group' | 'channel', limit: number, config: Config): Promise<TelegramMessage[]> {
    const cacheKey = `${sourceType}:${sourceName}`;

    // Get cached messages
    const cachedMessages = this.cache.getCachedMessages(cacheKey) || [];
    const lastTimestamp = this.cache.getLastMessageTimestamp(cacheKey);

    try {
      console.log(`  Fetching messages from ${sourceType} ${sourceName}...`);
      if (cachedMessages.length > 0) {
        console.log(`  Found ${cachedMessages.length} cached messages`);
      }

      const entity = await this.client.getEntity(sourceName);

      // Determine offset date - use last cached message timestamp or config timestamp
      let offsetDate: number | undefined;
      if (lastTimestamp) {
        offsetDate = Math.floor(new Date(lastTimestamp).getTime() / 1000);
      } else if (config.lastGenerationTimestamp) {
        offsetDate = Math.floor(parse(config.lastGenerationTimestamp, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", new Date()).getTime() / 1000);
      }

      const telegramMessages = await this.client.getMessages(entity, {
        limit: limit,
        offsetDate: offsetDate
      });

      const newMessages: TelegramMessage[] = [];
      for (const msg of telegramMessages) {
        if (msg.message) {
          newMessages.push({
            timestamp: new Date(msg.date * 1000).toISOString(),
            content: msg.message,
            link: `https://t.me/${sourceName}/${msg.id}`
          });
        }
      }

      console.log(`  Fetched ${newMessages.length} new messages from ${sourceType} ${sourceName}`);

      // Combine cached and new messages, sort by timestamp, remove duplicates
      const allMessages = [...cachedMessages, ...newMessages];
      const uniqueMessages = Array.from(
        new Map(allMessages.map(msg => [msg.link, msg])).values()
      ).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Update cache with all messages
      this.cache.cacheMessages(cacheKey, uniqueMessages);

      console.log(`  Total messages (cached + new): ${uniqueMessages.length}`);

      return uniqueMessages;
    } catch (error) {
      console.error(`Error fetching from ${sourceType} ${sourceName}:`, error);
      // Return cached messages if fetch fails
      return cachedMessages;
    }
  }

  async fetchMessages(config: Config): Promise<TelegramMessage[]> {
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

    return allMessages.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  async disconnect(): Promise<void> {
    try {
      // Give a brief moment for any ongoing operations to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.client.disconnect();
      await this.client.destroy();
      console.log('Disconnected from Telegram');
    } catch (error) {
      // Ignore disconnect errors as they're often harmless timeouts from _updateLoop
      console.log('Disconnection completed (ignoring timeout errors)');
    }
  }
}