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
