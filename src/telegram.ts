import { TelegramClient as GramJSClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { TelegramMessage, Config } from './types';
import { parse } from 'date-fns';

export class TelegramClient {
  private client: GramJSClient;
  private session: StringSession;

  constructor() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID!);
    const apiHash = process.env.TELEGRAM_API_HASH!;
    
    this.session = new StringSession('');
    this.client = new GramJSClient(this.session, apiId, apiHash, {
      connectionRetries: 5,
    });
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
          rl.question('Password? ', (answer: string) => {
            rl.close();
            resolve(answer);
          });
        });
      },
      phoneCode: async () => {
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        return new Promise((resolve) => {
          rl.question('Code? ', (answer: string) => {
            rl.close();
            resolve(answer);
          });
        });
      },
      onError: (err: any) => console.log(err),
    });
    console.log('Connected to Telegram');
  }

  async fetchMessages(config: Config): Promise<TelegramMessage[]> {
    const allMessages: TelegramMessage[] = [];
    
    const allChannels = [...config.groupsToParse, ...config.channelsToParse];
    
    for (const channelName of allChannels) {
      try {
        console.log(`Fetching messages from ${channelName}...`);
        
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
        
        console.log(`Fetched ${messages.length} messages from ${channelName}`);
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