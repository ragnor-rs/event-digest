/**
 * Escapes text for Telegram's HTML parse mode.
 *
 * Only these three characters carry meaning in that mode, which is the reason
 * the sender uses HTML rather than Markdown: every string on an event line is
 * model-generated or copied from a post, and `&` alone is common enough in real
 * data ("D&D Open Tables", "Grape Wine & Kitchen") that unescaped text would
 * make Telegram reject whole batches. Markdown would need a larger, dialect-
 * dependent escape set for the same job.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
