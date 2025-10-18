/**
 * Interface for AI client operations
 * This allows domain services to remain independent of specific AI implementations
 */
export interface IAIClient {
  /**
   * Call the AI model with a prompt
   * @param prompt The prompt to send to the AI
   * @returns The AI response text, or undefined if no response
   */
  call(prompt: string): Promise<string | undefined>;

  /**
   * Call the AI model with a prompt optimized for creative outputs
   * @param prompt The prompt to send to the AI
   * @returns The AI response text, or undefined if no response
   */
  callCreative(prompt: string): Promise<string | undefined>;
}
