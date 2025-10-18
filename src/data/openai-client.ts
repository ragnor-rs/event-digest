import OpenAI from 'openai';

import { IAIClient } from '../domain/interfaces';
import { OPENAI_MAX_RETRIES, OPENAI_INITIAL_BACKOFF_MS } from '../config/constants';
import { delay, RATE_LIMIT_DELAY } from '../shared/batch-processor';
import { Logger } from '../shared/logger';

const GPT_MODEL = 'gpt-5-mini';
const GPT_TEMPERATURE = 1.0;
export const GPT_TEMPERATURE_CREATIVE = 1.0;

export class OpenAIClient implements IAIClient {
  private client: OpenAI;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    this.client = new OpenAI({
      apiKey,
    });
  }

  async call(prompt: string): Promise<string | undefined> {
    return this.callWithTemperature(prompt, GPT_TEMPERATURE);
  }

  async callCreative(prompt: string): Promise<string | undefined> {
    return this.callWithTemperature(prompt, GPT_TEMPERATURE_CREATIVE);
  }

  private async callWithTemperature(prompt: string, temperature: number): Promise<string | undefined> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: GPT_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature,
        });

        const result = response.choices[0].message.content?.trim();
        await delay(RATE_LIMIT_DELAY);
        return result;
      } catch (error) {
        lastError = error;

        // Check if error is a rate limit error
        if (this.isRateLimitError(error)) {
          // Calculate exponential backoff: 2s, 4s, 8s
          const backoffMs = OPENAI_INITIAL_BACKOFF_MS * Math.pow(2, attempt);

          if (attempt < OPENAI_MAX_RETRIES) {
            this.logger.log(
              `  Rate limit exceeded. Retrying in ${backoffMs / 1000}s... (attempt ${attempt + 1}/${OPENAI_MAX_RETRIES})`
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
