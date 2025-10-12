import { Config } from '../../config/types';
import { Cache } from '../../data/cache';
import { OpenAIClient, GPT_TEMPERATURE_CREATIVE } from '../../data/openai-client';
import { DebugEventDescriptionEntry } from '../../presentation/debug-writer';
import { createBatches } from '../../shared/batch-processor';
import { Logger } from '../../shared/logger';
import { Event } from '../entities';

export async function describeEvents(
  events: Event[],
  config: Config,
  openaiClient: OpenAIClient,
  cache: Cache,
  debugEntries: DebugEventDescriptionEntry[],
  logger: Logger
): Promise<Event[]> {
  logger.log(`Generating descriptions for ${events.length} events...`);

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
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedEventDescription.title || 'N/A'}]`,
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
    logger.verbose(`  All events cached, skipping GPT calls`);
    logger.log(`  Created ${describedEvents.length} events`);
    return describedEvents;
  }

  const chunks = createBatches(uncachedEvents, config.gptBatchSizeEventDescription);

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

    const result = await openaiClient.callWithDelay(prompt, GPT_TEMPERATURE_CREATIVE);

    if (result) {
      const eventBlocks = result.split(/^\d+:/m).filter((block) => block.trim());

      for (let i = 0; i < eventBlocks.length && i < chunk.length; i++) {
        const block = eventBlocks[i];

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
          date_time: chunk[i].start_datetime!,
          met_interests: chunk[i].interests_matched!,
          ...eventDescriptionData,
          link: chunk[i].message.link,
        };

        describedEvents.push({ ...chunk[i], event_description: eventDescription });

        // Cache the full event description
        cache.cacheConvertedEvent(chunk[i].message.link, eventDescription, config.userInterests, false);

        if (title && summary && description) {
          logger.verbose(`    ✓ Created event: ${title}`);
        } else {
          logger.verbose(`    ✗ Failed to extract complete event info for ${chunk[i].message.link}`);
        }

        if (config.writeDebugFiles) {
          debugEntries.push({
            message: chunk[i].message,
            event_type: chunk[i].event_type!,
            start_datetime: chunk[i].start_datetime!,
            interests_matched: chunk[i].interests_matched!,
            gpt_prompt: prompt,
            gpt_response: result,
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
