import OpenAI from 'openai';

import { AICallOptions, IAIClient, ReasoningEffort } from '../domain/interfaces';
import { delay, RATE_LIMIT_DELAY } from '../shared/batch-processor';
import { Logger } from '../shared/logger';

// GPT-6-luna: OpenAI's most cost-efficient current-generation model, positioned for
// "focused, high-volume tasks" — classification, extraction, ranking and summarization,
// which is every GPT step in this pipeline. Half the price of the gpt-5.4-nano it
// replaced ($0.10/$0.50 vs $0.20/$1.25 per 1M tokens) with a 1.05M context window.
//
// Exported so cache keys can be scoped to the model that produced each entry.
export const GPT_MODEL = 'gpt-6-luna';

/**
 * Reasoning effort used when a caller does not specify one.
 * Callers normally pass the per-step value resolved from config.
 */
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

/**
 * Maximum number of retry attempts for OpenAI API calls when rate limited.
 * 3 retries provides good balance between resilience and fast failure.
 */
const OPENAI_MAX_RETRIES = 3;

/**
 * Initial backoff delay in milliseconds for OpenAI rate limit retries.
 * Uses exponential backoff: 2s, 4s, 8s for retries.
 * 2000ms (2 seconds) is a reasonable starting point for rate limit recovery.
 */
const OPENAI_INITIAL_BACKOFF_MS = 2000;

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

  async call(prompt: string, options?: AICallOptions): Promise<string | undefined> {
    return this.callWithEffort(prompt, options?.reasoningEffort ?? DEFAULT_REASONING_EFFORT);
  }

  private async callWithEffort(prompt: string, effort: ReasoningEffort): Promise<string | undefined> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: GPT_MODEL,
          messages: [{ role: 'user', content: prompt }],
          // No temperature: gpt-6-luna is a reasoning model and does not accept it.
          //
          // gpt-6-luna supports 'none', 'low', 'medium', 'high' and 'xhigh'. Reasoning
          // tokens share the completion-token budget, so steps that emit one block per
          // input message (event description) can truncate at higher effort levels.
          reasoning_effort: effort,
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
