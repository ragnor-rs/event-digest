import OpenAI from 'openai';
import { delay, RATE_LIMIT_DELAY } from '../shared/batch-processor';

export const GPT_MODEL = 'gpt-4o-mini';
export const GPT_TEMPERATURE = 0.0;
export const GPT_TEMPERATURE_CREATIVE = 0.3;

export class OpenAIClient {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }

  async call(prompt: string, temperature: number = GPT_TEMPERATURE): Promise<string | undefined> {
    try {
      const response = await this.client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      });

      return response.choices[0].message.content?.trim();
    } catch (error) {
      console.error('Error with OpenAI:', error);
      return undefined;
    }
  }

  async callWithDelay(prompt: string, temperature: number = GPT_TEMPERATURE): Promise<string | undefined> {
    const result = await this.call(prompt, temperature);
    await delay(RATE_LIMIT_DELAY);
    return result;
  }
}
