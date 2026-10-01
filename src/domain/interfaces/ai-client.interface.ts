/**
 * Reasoning effort levels supported by the AI model.
 *
 * Higher effort lets the model spend more reasoning tokens before emitting the
 * visible message. Those tokens share the completion budget, so raising effort
 * on a step that emits many output blocks risks truncating the response.
 *
 * Note: 'max' is documented by gpt-6-luna but is not yet in the openai@6 type
 * union, so it is intentionally excluded here.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Options controlling a single AI call
 */
export interface AICallOptions {
  /** Reasoning effort for this call; falls back to the client default when omitted */
  reasoningEffort?: ReasoningEffort;
  /**
   * Called when the model stopped because it ran out of completion budget rather
   * than because it had finished. The text returned alongside is a *prefix* of
   * the real answer.
   *
   * A callback rather than a thrown error or a richer return type: throwing
   * would let one over-long batch abort an entire run, and widening the return
   * type would churn all six other call sites for a condition only some of them
   * can act on. A step that caches its results needs to know — storing a prefix
   * under a key that will not change turns a transient cut-off into a permanent
   * wrong answer — while a step that cannot do better than its partial answer
   * can ignore it and still get the client's warning in the log.
   */
  onTruncated?: () => void;
}

/**
 * Interface for AI client operations
 * This allows domain services to remain independent of specific AI implementations
 */
export interface IAIClient {
  /**
   * Call the AI model with a prompt
   * @param prompt The prompt to send to the AI
   * @param options Per-call overrides such as reasoning effort
   * @returns The AI response text, or undefined if no response
   */
  call(prompt: string, options?: AICallOptions): Promise<string | undefined>;
}
