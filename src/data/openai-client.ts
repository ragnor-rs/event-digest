import OpenAI from 'openai';

import { delay, RATE_LIMIT_DELAY } from '../shared/batch-processor';

export const GPT_MODEL = 'gpt-4o-mini';
export const GPT_TEMPERATURE = 0.0;
export const GPT_TEMPERATURE_CREATIVE = 0.3;

export class OpenAIClient {
  private client: OpenAI;
  private readonly MAX_RETRIES = 3;
  private readonly INITIAL_BACKOFF_MS = 2000;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    this.client = new OpenAI({
      apiKey,
    });
  }

  async call(prompt: string, temperature: number = GPT_TEMPERATURE): Promise<string | undefined> {
    const response = await this.client.chat.completions.create({
      model: GPT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    });

    return response.choices[0].message.content?.trim();
  }

  async callWithDelay(prompt: string, temperature: number = GPT_TEMPERATURE): Promise<string | undefined> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const result = await this.call(prompt, temperature);
        await delay(RATE_LIMIT_DELAY);
        return result;
      } catch (error) {
        lastError = error;

        // Check if error is a rate limit error
        if (this.isRateLimitError(error)) {
          // Calculate exponential backoff: 2s, 4s, 8s
          const backoffMs = this.INITIAL_BACKOFF_MS * Math.pow(2, attempt);

          if (attempt < this.MAX_RETRIES) {
            console.error(
              `Rate limit exceeded. Retrying in ${backoffMs / 1000}s... (attempt ${attempt + 1}/${this.MAX_RETRIES})`
            );
            await delay(backoffMs);
            continue;
          }
        }

        // For non-rate-limit errors or exhausted retries, throw immediately
        throw error;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError;
  }

  private isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      return (
        errorMessage.includes('rate_limit') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('429') ||
        errorMessage.includes('too many requests')
      );
    }
    return false;
  }
}
