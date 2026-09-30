/**
 * Where an event takes place, as stated in the announcement.
 *
 * `matched_location` is the entry of `locationFilter` the event was judged to
 * fall in — a street address rarely names its city, so deciding that "Egnate
 * Ninoshvili St 8" is in Tbilisi is the model's job, not a string comparison.
 * It is undefined when no filter is configured or when nothing matched.
 */
export interface EventLocation {
  venue?: string; // "Fabrika"
  address?: string; // "Egnate Ninoshvili St 8"
  matched_location?: string; // Which entry of locationFilter this falls in
  confidence: number; // 0.0-1.0 confidence in the match, not in the extraction
}

/**
 * Renders a location as a single line, skipping whichever half is missing.
 * Falls back to the matched location when the model recognised the city but the
 * post named no venue; returns '' when there is nothing worth showing.
 */
export function formatLocation(location: EventLocation): string {
  return [location.venue, location.address].filter(Boolean).join(' — ') || location.matched_location || '';
}
