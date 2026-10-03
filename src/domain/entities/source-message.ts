export interface SourceMessage {
  timestamp: Date;
  content: string;
  link: string;
  /**
   * The channel or group this came from, as Telegram titles it ("АФИША ТБИЛИСИ
   * ДОСУГ", "Ночной Тбилиси / Night Tbilisi"), falling back to the config entry.
   *
   * Step 7 reads it as a last-resort city hint: a post naming only "Tatuza Jazz
   * Club" gives the model nothing to place, while the source it ran in usually
   * does. Deliberately not cached — it is attached to messages on the way out of
   * the fetch, so entries written before this field existed carry it too, and a
   * renamed channel takes effect on the next run rather than never.
   */
  source?: string;
}

/**
 * The link as a reader should see it: without the `#<n>` a step 3 fragment
 * carries.
 *
 * That suffix exists so fragments of one digest key the later caches apart, and
 * it has to stay on `link` for that. It has no meaning to a reader, though —
 * Telegram ignores it and opens the parent post either way — so a digest showing
 * "…/29499#5" is just advertising an internal id. Single source of truth for
 * both reporters and the calendar link, the way `formatLocation` is for 📍.
 */
export function postLink(message: SourceMessage): string {
  return message.link.replace(/#\d+$/, '');
}
