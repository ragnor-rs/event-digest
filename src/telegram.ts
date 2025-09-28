import { TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { TelegramMessage, Config } from './types';
import { parse } from 'date-fns';
import fs from 'fs';
import path from 'path';

export class TelegramClient {
  private client: GramJSClient;
  private session: StringSession;
  private sessionFile: string;

  constructor() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID!);
    const apiHash = process.env.TELEGRAM_API_HASH!;
    
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
    
    // Save session after successful connection
    this.saveSession();
    console.log('Connected to Telegram');
  }

  async fetchMessages(config: Config): Promise<TelegramMessage[]> {
    const allMessages: TelegramMessage[] = [];
    
    const allChannels = [...config.groupsToParse, ...config.channelsToParse];
    
    for (const channelName of allChannels) {
      try {
        console.log(`  Fetching messages from ${channelName}...`);
        
        const entity = await this.client.getEntity(channelName);
        
        const messages = await this.client.getMessages(entity, {
          limit: config.maxInputMessages,
          offsetDate: config.lastGenerationTimestamp ? 
            Math.floor(parse(config.lastGenerationTimestamp, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", new Date()).getTime() / 1000) : 
            undefined
        });

        for (const msg of messages) {
          if (msg.message) {
            allMessages.push({
              timestamp: new Date(msg.date * 1000).toISOString(),
              content: msg.message,
              link: `https://t.me/${channelName}/${msg.id}`
            });
          }
        }
        
        console.log(`  Fetched ${messages.length} messages from ${channelName}`);
      } catch (error) {
        console.error(`Error fetching from ${channelName}:`, error);
      }
    }

    return allMessages.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}