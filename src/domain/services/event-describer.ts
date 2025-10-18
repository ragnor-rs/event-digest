import { Config } from '../../config/types';
import { IAIClient, ICache } from '../interfaces';
import { DebugEventDescriptionEntry } from '../types';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { Event } from '../entities';

export async function describeEvents(
  events: Event[],
  config: Config,
  aiClient: IAIClient,
  cache: ICache,
  debugEntries: DebugEventDescriptionEntry[],
  logger: Logger
): Promise<Event[]> {
  if (events.length === 0) {
    logger.log(`  No input on this step`);
    return [];
  }

  // Check cache first
  const uncachedEvents: Event[] = [];
  const describedEvents: Event[] = [];
  let cacheHits = 0;

  for (const event of events) {
    const cachedEventDescription = cache.getConvertedEventCache(event.message.link, config.userInterests);
    if (cachedEventDescription !== undefined) {
      cacheHits++;
      // Update cached event description with current data (interests might have changed)
      const updatedEventDescription = {
        ...cachedEventDescription,
        date_time: event.start_datetime!,
        met_interests: event.interests_matched!,
        link: event.message.link,
      };
      describedEvents.push({ ...event, event_description: updatedEventDescription });

      if (config.writeDebugFiles) {
        debugEntries.push({
          message: event.message,
          event_type: event.event_type!,
          start_datetime: event.start_datetime!,
          interests_matched: event.interests_matched!,
          ai_prompt: '[CACHED]',
          ai_response: `[CACHED: ${cachedEventDescription.title || 'N/A'}]`,
          extracted_title: cachedEventDescription.title || 'N/A',
          extracted_summary: cachedEventDescription.short_summary || 'N/A',
          extraction_success: true,
          cached: true,
        });
      }
    } else {
      uncachedEvents.push(event);
    }
  }

  if (cacheHits > 0) {
    logger.verbose(`  Cache hits: ${cacheHits}/${events.length} events`);
  }

  if (uncachedEvents.length === 0) {
    logger.verbose(`  All events cached, skipping AI calls`);
    logger.log(`  Created ${describedEvents.length} events`);
    return describedEvents;
  }

  const chunks = createBatches(uncachedEvents, config.eventDescriptionBatchSize);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    logger.verbose(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} events)...`);

    const eventsText = chunk
      .map(
        (event, idx) => `${idx + 1}.
Start time: ${event.start_datetime}
Interests: ${event.interests_matched!.join(', ')}
Content: ${event.message.content.replace(/\n/g, ' ')}
Link: ${event.message.link}`
      )
      .join('\n\n');

    const prompt = config.eventDescriptionPrompt!.replace('{{EVENTS}}', eventsText);

    const result = await aiClient.callCreative(prompt);

    if (result) {
      const eventBlocks = result.split(/^\d+:/m).filter((block) => block.trim());

      // Create a map of event indices to blocks for safer access
      const blockMap = new Map<number, string>();
      eventBlocks.forEach((block, idx) => {
        if (idx < chunk.length) {
          blockMap.set(idx, block);
        }
      });

      // Process each event in the chunk
      for (let eventIdx = 0; eventIdx < chunk.length; eventIdx++) {
        const event = chunk[eventIdx];

        // Get the corresponding block from the map
        const block = blockMap.get(eventIdx);

        if (!block) {
          // AI didn't return a response for this event
          logger.verbose(`    ✗ No AI response for event ${eventIdx + 1}: ${event.message.link}`);

          // Create fallback event description
          const fallbackDescription = {
            date_time: event.start_datetime!,
            met_interests: event.interests_matched!,
            title: 'Event',
            short_summary: 'Event details not available',
            link: event.message.link,
          };

          describedEvents.push({ ...event, event_description: fallbackDescription });
          cache.cacheConvertedEvent(event.message.link, fallbackDescription, config.userInterests, false);

          if (config.writeDebugFiles) {
            debugEntries.push({
              message: event.message,
              event_type: event.event_type!,
              start_datetime: event.start_datetime!,
              interests_matched: event.interests_matched!,
              ai_prompt: prompt,
              ai_response: '[NO RESPONSE]',
              extracted_title: 'Event',
              extracted_summary: 'Event details not available',
              extraction_success: false,
              cached: false,
            });
          }
          continue;
        }

        // Find TITLE, SUMMARY, DESCRIPTION using more robust matching
        const titleMatch = block.match(/\bTITLE:\s*(.+?)(?=\n|$)/i);
        const summaryMatch = block.match(/\bSUMMARY:\s*(.+?)(?=\n\s*DESCRIPTION:|$)/is);
        const descriptionMatch = block.match(/\bDESCRIPTION:\s*([\s\S]*?)(?=\n\s*Link:|$)/i);

        const title = titleMatch ? titleMatch[1].trim() : '';
        const summary = summaryMatch ? summaryMatch[1].trim() : '';
        const description = descriptionMatch ? descriptionMatch[1].trim() : '';

        const eventDescriptionData = {
          title: title || 'Event',
          short_summary: summary || 'Event details not extracted properly',
        };

        const eventDescription = {
          date_time: event.start_datetime!,
          met_interests: event.interests_matched!,
          ...eventDescriptionData,
          link: event.message.link,
        };

        describedEvents.push({ ...event, event_description: eventDescription });

        // Cache the full event description
        cache.cacheConvertedEvent(event.message.link, eventDescription, config.userInterests, false);

        if (title && summary && description) {
          logger.verbose(`    ✓ Created event: ${title}`);
        } else {
          logger.verbose(`    ✗ Failed to extract complete event info for ${event.message.link}`);
        }

        if (config.writeDebugFiles) {
          debugEntries.push({
            message: event.message,
            event_type: event.event_type!,
            start_datetime: event.start_datetime!,
            interests_matched: event.interests_matched!,
            ai_prompt: prompt,
            ai_response: result,
            extracted_title: title,
            extracted_summary: summary,
            extraction_success: !!(title && summary && description),
            cached: false,
          });
        }
      }
    }

    // Save cache after processing batch
    cache.save();
  }

  logger.log(`  Created ${describedEvents.length} events`);
  return describedEvents;
}
