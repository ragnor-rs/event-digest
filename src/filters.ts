import OpenAI from 'openai';
import { TelegramMessage, EventAnnouncement, InterestingAnnouncement, ScheduledEvent, Config } from './types';
import { parse, getDay, getHours, getMinutes, isValid } from 'date-fns';
import { Cache } from './cache';
import { debugWriter } from './debug';

// Single source of truth for date normalization
function normalizeDateTime(dateTime: string): string {
  if (dateTime === 'unknown') return dateTime;
  // Fix incomplete format: "06 Sep 2025 18" → "06 Sep 2025 18:00"
  return dateTime.match(/^\d{2} \w{3} \d{4} \d{2}$/) ? dateTime + ':00' : dateTime;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function filterEventMessages(messages: TelegramMessage[], config: Config): Promise<TelegramMessage[]> {
  console.log(`Step 2: Filtering ${messages.length} messages for event cues...`);
  
  const eventMessages = messages.filter(msg => {
    const content = msg.content.toLowerCase();
    for (const lang in config.eventMessageCues) {
      for (const cue of config.eventMessageCues[lang]) {
        if (content.includes(cue.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  });

  console.log(`  Found ${eventMessages.length} messages with event cues`);
  return eventMessages;
}

export async function filterByEventMessages(messages: TelegramMessage[], config: Config): Promise<TelegramMessage[]> {
  console.log(`Step 3: Using GPT to filter ${messages.length} messages for event announcements...`);

  if (messages.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  console.log(`  Processing cache...`);
  const cache = new Cache();
  const debugResults: Array<{
    messageLink: string;
    isEvent: boolean;
    cached: boolean;
    prompt?: string;
    gptResponse?: string;
  }> = [];

  // Check cache first
  const uncachedMessages: TelegramMessage[] = [];
  const eventMessages: TelegramMessage[] = [];
  let cacheHits = 0;

  for (const message of messages) {
    const cachedResult = cache.isEventMessageCached(message.link);
    if (cachedResult !== null) {
      cacheHits++;
      if (cachedResult) {
        eventMessages.push(message);
        debugResults.push({
          messageLink: message.link,
          isEvent: true,
          cached: true,
        });
      } else {
        console.log(`    DISCARDED: ${message.link} - not an event announcement (cached)`);
        debugResults.push({
          messageLink: message.link,
          isEvent: false,
          cached: true,
        });
      }
    } else {
      uncachedMessages.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  GPT identified ${eventMessages.length} event messages`);

    if (config.writeDebugFiles) {
      debugWriter.writeEventDetection(debugResults);
    }

    return eventMessages;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    // No offline filtering at this step

    const prompt = `Analyze these messages and identify which ones are announcements for a SINGLE SPECIFIC EVENT.

An event announcement should include:
- A specific date/time (can be relative like "сегодня/today", "завтра/tomorrow", specific times like "19:30", or absolute dates)
- A specific activity, meetup, workshop, presentation, talk, or gathering
- Details about what will happen (even if brief)

INCLUDE messages that:
- Announce workshops, meetups, presentations, talks, networking events, webinars, broadcasts
- Have clear timing information (specific time, date, or relative dates)  
- Describe a specific gathering or activity (online or offline)
- Invite people to participate, attend, or join something specific
- Contain meeting links (Zoom, Google Meet, etc.) with scheduled times
- Use words like "приходите/come", "присоединяйтесь/join", "встреча/meeting", "событие/event", "вещать/broadcast"
- Ask people to set calendar reminders or save dates
- Provide specific times with timezone information (МСК, GMT, etc.)

EXCLUDE only messages that:
- Are clearly event digests/roundups listing multiple different events
- Are general announcements without specific timing or scheduling
- Are purely informational posts without inviting participation
- Are job postings, news articles, or promotional content without events

IMPORTANT: Look for timing indicators in ANY language:
- Russian: сегодня, завтра, время, встреча, МСК, вещать
- English: today, tomorrow, time, meeting, at X:XX, broadcast
- Numbers indicating time: 19:30, 14:00, etc.
- Calendar references: "ставьте в календарь", "set reminder", "save the date"

EXAMPLE of what should be INCLUDED:
- A message saying "Today at 19:30 MSK I will broadcast about LinkedIn" with a Zoom link → This IS an event
- A message with "сегодня вещать" + time + meeting link → This IS an event

Messages:
${chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')}

CRITICAL: Respond with each qualifying message number, one per line (e.g., "1", "3", "7"). If none qualify, respond with "none".`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result && result !== 'none') {
        const lines = result.split('\n').filter(line => line.trim());
        const processedIndices = new Set<number>();

        for (const line of lines) {
          const match = line.trim().match(/^(\d+)$/);
          if (match) {
            const idx = parseInt(match[1]) - 1;

            if (idx >= 0 && idx < chunk.length) {
              eventMessages.push(chunk[idx]);
              cache.cacheEventMessage(chunk[idx].link, true, false);
              processedIndices.add(idx);

              debugResults.push({
                messageLink: chunk[idx].link,
                isEvent: true,
                cached: false,
                prompt,
                gptResponse: result,
              });
            }
          }
        }

        // Cache negative results for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedIndices.has(idx)) {
            console.log(`    DISCARDED: ${chunk[idx].link} - not an event announcement`);
            cache.cacheEventMessage(chunk[idx].link, false, false);

            debugResults.push({
              messageLink: chunk[idx].link,
              isEvent: false,
              cached: false,
              prompt,
              gptResponse: result,
            });
          }
        }
      } else {
        // All messages in chunk are not events
        for (const message of chunk) {
          console.log(`    DISCARDED: ${message.link} - not an event announcement`);
          cache.cacheEventMessage(message.link, false, false);

          debugResults.push({
            messageLink: message.link,
            isEvent: false,
            cached: false,
            prompt,
            gptResponse: result || 'none',
          });
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Save cache after processing batch
    cache.save();
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  GPT identified ${eventMessages.length} event messages`);

  if (config.writeDebugFiles) {
    debugWriter.writeEventDetection(debugResults);
  }

  return eventMessages;
}

export async function convertToEventAnnouncements(messages: TelegramMessage[], config: Config): Promise<EventAnnouncement[]> {
  console.log(`Step 4: Converting ${messages.length} messages to event announcements...`);

  if (messages.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }

  const cache = new Cache();
  const eventAnnouncements: EventAnnouncement[] = [];
  const uncachedMessages: TelegramMessage[] = [];
  let cacheHits = 0;

  console.log('  Processing cache...');
  for (const message of messages) {
    const cachedType = cache.getEventTypeCache(message.link);
    if (cachedType !== null) {
      cacheHits++;

      // Check if we should include this event based on skipOnlineEvents
      if (cachedType === 'online' && config.skipOnlineEvents) {
        console.log(`    DISCARDED: ${message.link} [${cachedType}] - skipping online events (cached)`);
        debugWriter.addStep4Entry({
          message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: 'discarded',
          substep: '4_classification',
          cached: true
        });
      } else {
        eventAnnouncements.push({
          message,
          event_type: cachedType
        });
        debugWriter.addStep4Entry({
          message,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: ${cachedType}]`,
          result: cachedType,
          substep: '4_classification',
          cached: true
        });
      }
    } else {
      uncachedMessages.push(message);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${messages.length} messages`);
  }

  if (uncachedMessages.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Created ${eventAnnouncements.length} event announcements`);
    return eventAnnouncements;
  }

  const chunks = [];
  for (let i = 0; i < uncachedMessages.length; i += 16) {
    chunks.push(uncachedMessages.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const prompt = `Classify each event message as offline, online, or hybrid.

CLASSIFICATION OPTIONS:
0: offline - in-person event at a physical location
1: online - virtual event only (Zoom, webinar, etc.)
2: hybrid - both in-person and online options available

OFFLINE EVENTS (0):
- Physical addresses or streets (e.g. "Khorava 18", "Terminal Abashidze")
- City names (e.g. "Тбилиси", "Tbilisi")
- Venue names (e.g. "F0RTHSP4CE", "Fragment", "Garage IT")
- Business names with @ symbol (e.g. "@the.hidden.bar")
- Office locations (e.g. "офис Garage IT")
- Map links (Google Maps, Yandex Maps)
- Keywords: "офис", "ресторан", "бар", "venue", "office", "приходи", "come to"

ONLINE EVENTS (1):
- Only Zoom/Google Meet/virtual links, no physical location
- Explicit "online only", "webinar", "virtual event"
- No mention of physical venue or address

HYBRID EVENTS (2):
- MUST have BOTH physical location AND online access explicitly mentioned
- Examples: "in person + online", "Zoom + venue", "livestream from office"
- Both options clearly available to attendees

Messages:
${chunk.map((message, idx) => `${idx + 1}. ${message.content.replace(/\n/g, ' ')}`).join('\n\n')}

For each message, respond with ONLY the message number and classification index:
FORMAT: MESSAGE_NUMBER: INDEX
Example: 1: 0
Example: 2: 1
Example: 3: 2

Respond with one classification per line.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      const processedIndices = new Set<number>();

      if (result) {
        const lines = result.split('\n').filter(line => line.trim());

        for (const line of lines) {
          const match = line.trim().match(/^(\d+)\s*:\s*(\d+)$/);
          if (match) {
            const messageIdx = parseInt(match[1]) - 1;
            const classificationIdx = parseInt(match[2]);

            if (messageIdx >= 0 && messageIdx < chunk.length && classificationIdx >= 0 && classificationIdx <= 2) {
              const eventType = classificationIdx === 0 ? 'offline' : classificationIdx === 1 ? 'online' : 'hybrid';

              // Cache the result
              cache.cacheEventType(chunk[messageIdx].link, eventType, false);
              processedIndices.add(messageIdx);

              // Check if we should include this event
              if (eventType === 'online' && config.skipOnlineEvents) {
                console.log(`    DISCARDED: ${chunk[messageIdx].link} [${eventType}] - skipping online events`);
                debugWriter.addStep4Entry({
                  message: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result,
                  result: 'discarded',
                  substep: '4_classification',
                  cached: false
                });
              } else {
                eventAnnouncements.push({
                  message: chunk[messageIdx],
                  event_type: eventType
                });
                debugWriter.addStep4Entry({
                  message: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result,
                  result: eventType,
                  substep: '4_classification',
                  cached: false
                });
              }
            }
          }
        }
      }

      // Handle unprocessed messages (shouldn't happen, but just in case)
      for (let idx = 0; idx < chunk.length; idx++) {
        if (!processedIndices.has(idx)) {
          console.log(`    WARNING: ${chunk[idx].link} - no classification received, defaulting to offline`);
          const eventType = 'offline';
          cache.cacheEventType(chunk[idx].link, eventType, false);
          eventAnnouncements.push({
            message: chunk[idx],
            event_type: eventType
          });
          debugWriter.addStep4Entry({
            message: chunk[idx],
            gpt_prompt: prompt,
            gpt_response: result || '[NO RESPONSE]',
            result: eventType,
            substep: '4_classification',
            cached: false
          });
        }
      }
    } catch (error) {
      console.error('Error with OpenAI event classification:', error);
      // On error, add all as offline events
      for (const message of chunk) {
        eventAnnouncements.push({
          message,
          event_type: 'offline'
        });
      }
    }

    cache.save();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Created ${eventAnnouncements.length} event announcements`);
  return eventAnnouncements;
}

export async function filterByInterests(announcements: EventAnnouncement[], config: Config): Promise<InterestingAnnouncement[]> {
  console.log(`Step 5: Filtering ${announcements.length} event announcements by user interests...`);
  
  if (announcements.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }
  
  const cache = new Cache();
  
  // Check cache first
  const uncachedAnnouncements: EventAnnouncement[] = [];
  const interestingAnnouncements: InterestingAnnouncement[] = [];
  let cacheHits = 0;

  console.log('  Processing cache...');
  for (const announcement of announcements) {
    const cachedInterests = cache.getMatchingInterestsCache(announcement.message.link, config.userInterests);
    if (cachedInterests !== null) {
      cacheHits++;
      if (cachedInterests.length > 0) {
        interestingAnnouncements.push({
          announcement,
          interests_matched: cachedInterests
        });
        debugWriter.addStep5Entry({
          announcement,
          gpt_prompt: '[CACHED]',
          gpt_response: `[CACHED: matched interests: ${cachedInterests.join(', ')}]`,
          interests_matched: cachedInterests,
          result: 'matched',
          cached: true
        });
      } else {
        console.log(`    DISCARDED: ${announcement.message.link} - no interests matched (cached)`);
        debugWriter.addStep5Entry({
          announcement,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: no interests matched]',
          interests_matched: [],
          result: 'discarded',
          cached: true
        });
      }
    } else {
      uncachedAnnouncements.push(announcement);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${announcements.length} messages`);
  }

  if (uncachedAnnouncements.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Found ${interestingAnnouncements.length} messages matching user interests`);
    return interestingAnnouncements;
  }
  
  const chunks: EventAnnouncement[][] = [];
  for (let i = 0; i < uncachedAnnouncements.length; i += 16) {
    chunks.push(uncachedAnnouncements.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk: EventAnnouncement[] = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);

    const prompt: string = `Analyze these event messages and identify which user interests they match. Match events that are DIRECTLY about the interest topic or provide significant learning/practice in that area.

User interests: ${config.userInterests.join(', ')}

CRITICAL: Be more inclusive when matching interests. Social gatherings, professional meetups, and technical discussions should match multiple relevant categories.

MATCHING GUIDELINES:

TECHNOLOGY INTERESTS:
- "AI": Events about artificial intelligence, machine learning models, LLMs, neural networks, AI tools, prompt engineering, reasoning models like DeepSeek
- "ML": Machine learning courses, model training, data science workshops, Linear Algebra lectures (fundamental to ML)
- "Backend": Server-side programming, APIs, databases, system architecture, JavaScript/JS meetups, tech community events
- "Computer hardware": Hardware components, electronics, IoT, technical equipment
- "Android/Flutter": Mobile development, app building

MUSIC INTERESTS:
- "Electronic music": DJ sets, electronic dance music, EDM events, electronic music production, dance parties, club events
- "Rock": Rock band concerts, rock music performances, rock festivals, live rock bands with "драйвовые рифы" (driving riffs)
- "Jazz": Jazz concerts, jazz clubs, jazz music events
- "Metal": Metal band concerts, metal music events
- Music theory workshops and composition classes match ALL music interests

BUSINESS INTERESTS:
- "VC": Venture capital discussions, investor meetings, startup pitching, funding, FOUNDER events, ENTREPRENEUR meetups, STARTUP conferences, tech entrepreneurship, IT entrepreneur gatherings, founders' events, venture ecosystem, angel investor networks, pitch sessions, startup ecosystem events
- "Investments": Investment strategies, financial markets, portfolio discussions
- "Networking": Business networking events, professional meetups, industry connections, IT social events
- "Productivity": Time management, efficiency workshops, productivity tools, personal development, NLP workshops
- "Business events": Corporate events, business meetups, professional gatherings
- "Social events": Social gatherings, parties, networking events, community events, cultural celebrations

PHYSICAL ACTIVITIES:
- "Travel": Tourism, city tours, guided trips
- "Industrial tourism": Tours of abandoned places, factory visits, urban exploration, Soviet sanatorium tours
- "Hiking": Mountain trips, nature walks, outdoor adventures

SCIENCE INTERESTS:
- "Astronomy": Space events, космонавтика (cosmonautics), космические аппараты (spacecraft), CubeSat satellites, space exploration, planets, stars, космическая эра (space era), астрономия
- "Physics": Physics lectures, physical phenomena, quantum mechanics, космические масштабы (cosmic scales), physics workshops
- "Neuroscience": Brain science, neurobiology, cognitive science, neurological topics
- "Radio": Radio communication, радио, рации (radios), SSTV reception, radio equipment, amateur radio, radio waves, МКС/ISS communication, радиодень (radio day)

CULTURAL INTERESTS:
- "English": Language learning events, English conversation clubs
- "Fantasy": Fantasy films (Miyazaki, fantasy cinema), fantasy literature events
- "Sci-fi": Science fiction events, sci-fi screenings

GAMES & ACTIVITIES:
- "Board games": Chess tournaments (шахматы, рапид, турнир), board game nights, strategy games, card games
- "Quiz": Quiz nights, trivia competitions, knowledge contests

SPECIFIC KEYWORDS TO RECOGNIZE (ALWAYS MATCH THESE):
- Chess events (рапид, турнир, шахматы, chess) → "Board games"
- JavaScript/JS meetups, Apple Events viewing → "Backend"
- AI model names (GPT, DeepSeek, LangChain, reasoning models, prompt engineering) → "AI"
- DJ events, dance parties, club events → "Electronic music"
- Live band concerts, rock performances → "Rock"
- Music theory, composition workshops → match all music interests
- Karaoke events, singing events → "Social events"
- IT networking, tech community events, "айти нытьё" → "Backend", "Networking", "Social events"
- TouchDesigner, 3D composition, technical workshops → "Computer hardware"
- Personal branding, blogging growth → "Business events", "Networking"
- Personal development, NLP workshops → "Productivity"
- Abandoned places tours, Soviet heritage → "Industrial tourism"
- Social gatherings, parties, bar events → "Social events"
- Fantasy films (Miyazaki) → "Fantasy"
- Space/космос events (космонавтика, CubeSat, спутники, космическая эра, МКС, ISS) → "Astronomy", "Physics"
- Radio events (радиодень, рации, SSTV, радио, radio equipment, amateur radio) → "Radio"
- Biology lectures (биология, прорывы биологии, neurobiology) → match relevant science interests
- Physics/Astronomy lectures (физика, астрономия, космические масштабы) → "Physics", "Astronomy"
- VC/Startup/Founder events (founders, IT-предприниматели, tech entrepreneurs, startup ecosystem, венчур, pitch sessions, angel investors, Unicorn Embassy) → "VC", "Networking", "Business events"

MANDATORY MATCHES - THESE MUST ALWAYS BE MATCHED:
- Any event mentioning "DeepSeek" → "AI"
- Any karaoke or singing event → "Social events"
- Any IT/tech networking event, "айти нытьё", IT meetups → "Backend" + "Networking" + "Social events"
- Any personal branding/blogging event, "личный бренд", blog growth → "Business events" + "Networking"
- Events about growing followers, blog monetization, personal brand building → "Business events" + "Networking"
- Any VC/startup/founder event (founders, IT-предприниматели, tech entrepreneurs, startup, венчур, Founders Mondays, pitch session, angel investors, Unicorn Embassy, startup ecosystem) → "VC" + "Networking" + "Business events"
- Any space/космос event (космонавтика, CubeSat, спутники, космическая эра, МКС, ISS) → "Astronomy" (+ "Physics" if applicable)
- Any radio event (радиодень, рации, SSTV, amateur radio, radio communication) → "Radio"
- Any astronomy lecture (астрономия, planets, космические масштабы) → "Astronomy"
- Any physics lecture (физика, physical phenomena, quantum) → "Physics"

CRITICAL INSTRUCTIONS - FOLLOW THESE EXACTLY:
1. If you see "айти нытьё" (IT networking) → ALWAYS match "Backend", "Networking", "Social events"
2. If you see "личный бренд" or "блог" growth/monetization → ALWAYS match "Business events", "Networking"
3. If you see "DeepSeek" or AI model names → ALWAYS match "AI"
4. If you see "караоке" (karaoke), singing events → ALWAYS match "Social events"
5. If you see "теория музыки" (music theory), composition → ALWAYS match ALL music interests
6. If you see "Миядзаки" (Miyazaki), fantasy films → ALWAYS match "Fantasy"
7. If you see "драйвовые рифы" (driving riffs), live rock bands → ALWAYS match "Rock"
8. If you see hardware swap, hacker events → ALWAYS match "Computer hardware"
9. If you see "космонавтика", "CubeSat", "спутники", "космическая эра", "МКС", "ISS" → ALWAYS match "Astronomy" (and "Physics" if relevant)
10. If you see "радиодень", "рации", "SSTV", "радио", "radio equipment" → ALWAYS match "Radio"
11. If you see "биология", neuroscience topics → ALWAYS match relevant science interests ("Neuroscience" if brain-related)
12. If you see space + radio (космос + радио) → ALWAYS match BOTH "Astronomy" AND "Radio"
13. If you see "founders", "IT-предприниматели", "tech entrepreneurs", "startup", "венчур", "Founders Mondays", "pitch", "angel investors", "Unicorn Embassy", "VC" (in event name) → ALWAYS match "VC", "Networking", "Business events"

BE MORE INCLUSIVE, NOT RESTRICTIVE. When in doubt, match multiple relevant interests.

Messages:
${chunk.map((announcement: EventAnnouncement, idx: number) => `${idx + 1}. ${announcement.message.content.replace(/\n/g, ' ')}`).join('\n\n')}

For each message that matches at least one interest, respond in this format:
MESSAGE_NUMBER: interest1, interest2
Example: 1: AI, Backend

If a message doesn't match any interests, don't include it in your response.`;

    try {
      const response: any = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result: string | undefined = response.choices[0].message.content?.trim();
      if (result) {
        // Check for explicit "no matches" responses
        if (result.toLowerCase().includes('no messages match') ||
            result.toLowerCase().includes('none qualify') ||
            result.toLowerCase().trim() === 'none') {
          // All announcements have no matches - cache them as empty
          for (const announcement of chunk) {
            console.log(`    DISCARDED: ${announcement.message.link} - no interests matched`);
            cache.cacheMatchingInterests(announcement.message.link, [], config.userInterests, false);
            debugWriter.addStep5Entry({
              announcement,
              gpt_prompt: prompt,
              gpt_response: result,
              interests_matched: [],
              result: 'discarded',
              cached: false
            });
          }
        } else {
          // Parse normal MESSAGE_NUMBER: interests format
          const lines: string[] = result.split('\n').filter((line: string) => /^\s*\d+\s*:/.test(line));
          const processedMessages = new Set<number>();

          for (const line of lines) {
            const [numPart, interestsPart]: string[] = line.split(':');
            const messageIdx: number = parseInt(numPart.trim()) - 1;
            const rawInterests: string[] = interestsPart.split(',').map((s: string) => s.trim()).filter((s: string) => s);

            // Validate that GPT's returned interests actually exist in the user's interest list
            const validInterests: string[] = rawInterests.filter((interest: string) =>
              config.userInterests.some((userInterest: string) =>
                userInterest.toLowerCase() === interest.toLowerCase()
              )
            );

            // Log any invalid interests that GPT hallucinated
            const invalidInterests: string[] = rawInterests.filter((interest: string) =>
              !config.userInterests.some((userInterest: string) =>
                userInterest.toLowerCase() === interest.toLowerCase()
              )
            );
            if (invalidInterests.length > 0) {
              console.log(`    WARNING: GPT returned invalid interests for ${chunk[messageIdx]?.message.link}: ${invalidInterests.join(', ')}`);
            }

            if (messageIdx >= 0 && messageIdx < chunk.length && validInterests.length > 0) {
              interestingAnnouncements.push({
                announcement: chunk[messageIdx],
                interests_matched: validInterests
              });
              cache.cacheMatchingInterests(chunk[messageIdx].message.link, validInterests, config.userInterests, false);
              processedMessages.add(messageIdx);

              debugWriter.addStep5Entry({
                announcement: chunk[messageIdx],
                gpt_prompt: prompt,
                gpt_response: result,
                interests_matched: validInterests,
                result: 'matched',
                cached: false
              });
            } else if (messageIdx >= 0 && messageIdx < chunk.length && rawInterests.length > 0 && validInterests.length === 0) {
              // All interests were invalid, treat as no match
              processedMessages.add(messageIdx);
              console.log(`    DISCARDED: ${chunk[messageIdx].message.link} - all returned interests were invalid`);
              cache.cacheMatchingInterests(chunk[messageIdx].message.link, [], config.userInterests, false);
              debugWriter.addStep5Entry({
                announcement: chunk[messageIdx],
                gpt_prompt: prompt,
                gpt_response: result,
                interests_matched: [],
                result: 'discarded',
                cached: false
              });
            }
          }
          
          // Cache empty results for unmatched messages
          for (let idx = 0; idx < chunk.length; idx++) {
            if (!processedMessages.has(idx)) {
              console.log(`    DISCARDED: ${chunk[idx].message.link} - no interests matched`);
              cache.cacheMatchingInterests(chunk[idx].message.link, [], config.userInterests, false);
              debugWriter.addStep5Entry({
                announcement: chunk[idx],
                gpt_prompt: prompt,
                gpt_response: result,
                interests_matched: [],
                result: 'discarded',
                cached: false
              });
            }
          }
        }
      } else {
        // No matches in this chunk
        for (const announcement of chunk) {
          console.log(`    DISCARDED: ${announcement.message.link} - no interests matched`);
          cache.cacheMatchingInterests(announcement.message.link, [], config.userInterests, false);
          debugWriter.addStep5Entry({
            announcement,
            gpt_prompt: prompt,
            gpt_response: result || '[NO RESPONSE]',
            interests_matched: [],
            result: 'discarded',
            cached: false
          });
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Save cache after processing batch
    cache.save();
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Found ${interestingAnnouncements.length} messages matching user interests`);
  
  return interestingAnnouncements;
}

export async function filterBySchedule(announcements: InterestingAnnouncement[], config: Config): Promise<ScheduledEvent[]> {
  console.log(`Step 6: Filtering ${announcements.length} event announcements by schedule and future dates...`);
  
  if (announcements.length === 0) {
    console.log(`  No input on this step`);
    return [];
  }
  
  const cache = new Cache();
  
  // Check cache first
  const uncachedAnnouncements: InterestingAnnouncement[] = [];
  const scheduledEvents: ScheduledEvent[] = [];
  let cacheHits = 0;

  console.log('  Processing cache...');
  for (const announcement of announcements) {
    const cachedDateTime = cache.getScheduledEventCache(announcement.announcement.message.link, config.weeklyTimeslots);
    if (cachedDateTime !== null) {
      cacheHits++;
      if (cachedDateTime !== 'unknown') {
        // Re-validate against current time and schedule
        try {
          const normalizedCachedDateTime = normalizeDateTime(cachedDateTime);
          const eventDate = parse(normalizedCachedDateTime, 'dd MMM yyyy HH:mm', new Date());
          
          const now = new Date();
          if (eventDate > now) {
            const dayOfWeek = getDay(eventDate);
            const hour = getHours(eventDate);
            const minute = getMinutes(eventDate);
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            
            const matchesSchedule = config.weeklyTimeslots.some(slot => {
              const [slotDay, slotTime] = slot.split(' ');
              const slotDayNum = parseInt(slotDay);
              return slotDayNum === dayOfWeek && timeStr >= slotTime;
            });
            
            if (matchesSchedule) {
              scheduledEvents.push({
                interesting_announcement: announcement,
                start_datetime: normalizedCachedDateTime
              });
              debugWriter.addStep6Entry({
                announcement,
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'scheduled',
                cached: true
              });
            } else {
              console.log(`    DISCARDED: ${announcement.announcement.message.link} - outside desired timeslots (cached)`);
              debugWriter.addStep6Entry({
                announcement,
                gpt_prompt: '[CACHED]',
                gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
                extracted_datetime: normalizedCachedDateTime,
                result: 'discarded',
                discard_reason: 'outside desired timeslots',
                cached: true
              });
            }
          } else {
            console.log(`    DISCARDED: ${announcement.announcement.message.link} - event in the past (cached)`);
            debugWriter.addStep6Entry({
              announcement,
              gpt_prompt: '[CACHED]',
              gpt_response: `[CACHED: datetime ${normalizedCachedDateTime}]`,
              extracted_datetime: normalizedCachedDateTime,
              result: 'discarded',
              discard_reason: 'event in the past',
              cached: true
            });
          }
        } catch (error) {
          // If cached data is invalid, re-process
          uncachedAnnouncements.push(announcement);
        }
      } else {
        debugWriter.addStep6Entry({
          announcement,
          gpt_prompt: '[CACHED]',
          gpt_response: '[CACHED: unknown datetime]',
          extracted_datetime: 'unknown',
          result: 'discarded',
          discard_reason: 'no date/time found',
          cached: true
        });
      }
    } else {
      uncachedAnnouncements.push(announcement);
    }
  }

  if (cacheHits > 0) {
    console.log(`  Cache hits: ${cacheHits}/${announcements.length} messages`);
  }

  if (uncachedAnnouncements.length === 0) {
    console.log(`  All messages cached, skipping GPT calls`);
    console.log(`  Found ${scheduledEvents.length} messages matching schedule`);
    return scheduledEvents;
  }
  
  const chunks = [];
  for (let i = 0; i < uncachedAnnouncements.length; i += 16) {
    chunks.push(uncachedAnnouncements.slice(i, i + 16));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Processing batch ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
    
    const prompt = `Extract the start date and time for each event. Today's date is ${new Date().toDateString()}.

CRITICAL: Use message timestamps to infer the correct year for events. If an event mentions "March 15" and the message was posted on "March 10, 2024", the event is "March 15, 2024". If a message from "Dec 10, 2023" mentions "Jan 5", the event is "Jan 5, 2024" (next occurrence).

Messages with timestamps:
${chunk.map((announcement, idx) => {
  const messageDate = new Date(announcement.announcement.message.timestamp);
  return `${idx + 1}. [Posted: ${messageDate.toDateString()}] ${announcement.announcement.message.content.replace(/\n/g, ' ')}`;
}).join('\n\n')}

For each message, respond in this format:
MESSAGE_NUMBER: DD MMM YYYY HH:MM
Example: 1: 08 Jan 2025 14:00
Example: 2: 15 Dec 2024 19:30

CRITICAL FORMAT REQUIREMENTS:
- ALWAYS use the exact format: DD MMM YYYY HH:MM (with colon between hours and minutes)
- Time MUST have both hours AND minutes (e.g., 18:00, NOT just 18)
- If time is missing, estimate a reasonable time (e.g., 19:00 for evening events)
- If you can't determine the complete date/time, use "unknown"
- NEVER use formats like "06 Sep 2025 18" - this is WRONG
- CORRECT: "06 Sep 2025 18:00"
- WRONG: "06 Sep 2025 18"

YEAR INFERENCE RULES:
- If event date is after message date in same year, use same year
- If event date is before message date, use next year (e.g., Dec message mentioning Jan event = next year)
- Always ensure the event date is in the future relative to message timestamp`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const result = response.choices[0].message.content?.trim();
      if (result) {
        const lines = result.split('\n').filter(line => line.includes(':'));
        const processedMessages = new Set<number>();
        
        for (const line of lines) {
          const [numPart, datePart] = line.split(':');
          const messageIdx = parseInt(numPart.trim()) - 1;
          const dateTime = datePart.trim();
          
          // Cache the extracted datetime with proper formatting
          if (messageIdx >= 0 && messageIdx < chunk.length) {
            const normalizedDateTime = normalizeDateTime(dateTime);
            cache.cacheScheduledEvent(chunk[messageIdx].announcement.message.link, normalizedDateTime, config.weeklyTimeslots, false);
            processedMessages.add(messageIdx);
          }
          
          if (messageIdx >= 0 && messageIdx < chunk.length && dateTime !== 'unknown') {
            try {
              // Use normalized date for all processing
              const normalizedDateTime = normalizeDateTime(dateTime);
              const eventDate = parse(normalizedDateTime, 'dd MMM yyyy HH:mm', new Date());
              
              // Check if the date is valid
              if (!isValid(eventDate)) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - could not parse date`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: dateTime,
                  result: 'discarded',
                  discard_reason: 'could not parse date',
                  cached: false
                });
                continue;
              }
              
              // Validate event date against message timestamp
              const messageDate = new Date(chunk[messageIdx].announcement.message.timestamp);
              const now = new Date();
              
              // Check if the event is in the future relative to current time
              if (eventDate <= now) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - event in the past`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'event in the past',
                  cached: false
                });
                continue;
              }
              
              // Check if event date is reasonable relative to message date (not more than 2 years in the future)
              const maxFutureDate = new Date(messageDate.getTime() + (2 * 365 * 24 * 60 * 60 * 1000)); // 2 years from message
              if (eventDate > maxFutureDate) {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - event too far in future`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'event too far in future',
                  cached: false
                });
                continue;
              }
              
              const dayOfWeek = getDay(eventDate);
              const hour = getHours(eventDate);
              const minute = getMinutes(eventDate);
              
              const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
              const dayTimeStr = `${dayOfWeek} ${timeStr}`;
              
              const matchesSchedule = config.weeklyTimeslots.some(slot => {
                const [slotDay, slotTime] = slot.split(' ');
                const slotDayNum = parseInt(slotDay);
                return slotDayNum === dayOfWeek && timeStr >= slotTime;
              });
              
              if (matchesSchedule) {
                scheduledEvents.push({
                  interesting_announcement: chunk[messageIdx],
                  start_datetime: normalizedDateTime
                });
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'scheduled',
                  cached: false
                });
              } else {
                console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - outside desired timeslots`);
                debugWriter.addStep6Entry({
                  announcement: chunk[messageIdx],
                  gpt_prompt: prompt,
                  gpt_response: result || '',
                  extracted_datetime: normalizedDateTime,
                  result: 'discarded',
                  discard_reason: 'outside desired timeslots',
                  cached: false
                });
              }
            } catch (error) {
              console.log(`    DISCARDED: ${chunk[messageIdx].announcement.message.link} - date parsing error`);
              debugWriter.addStep6Entry({
                announcement: chunk[messageIdx],
                gpt_prompt: prompt,
                gpt_response: result || '',
                extracted_datetime: dateTime,
                result: 'discarded',
                discard_reason: 'date parsing error',
                cached: false
              });
            }
          }
        }
        
        // Cache 'unknown' for unprocessed messages
        for (let idx = 0; idx < chunk.length; idx++) {
          if (!processedMessages.has(idx)) {
            console.log(`    DISCARDED: ${chunk[idx].announcement.message.link} - no date/time found`);
            cache.cacheScheduledEvent(chunk[idx].announcement.message.link, 'unknown', config.weeklyTimeslots, false);
            debugWriter.addStep6Entry({
              announcement: chunk[idx],
              gpt_prompt: prompt,
              gpt_response: result || '',
              extracted_datetime: 'unknown',
              result: 'discarded',
              discard_reason: 'no date/time found',
              cached: false
            });
          }
        }
      } else {
        // No results from GPT, cache as unknown
        for (const announcement of chunk) {
          console.log(`    DISCARDED: ${announcement.announcement.message.link} - no date/time found`);
          cache.cacheScheduledEvent(announcement.announcement.message.link, 'unknown', config.weeklyTimeslots, false);
          debugWriter.addStep6Entry({
            announcement,
            gpt_prompt: prompt,
            gpt_response: result || '[NO RESPONSE]',
            extracted_datetime: 'unknown',
            result: 'discarded',
            discard_reason: 'no date/time found',
            cached: false
          });
        }
      }
    } catch (error) {
      console.error('Error with OpenAI:', error);
    }
    
    // Save cache after processing batch
    cache.save();
    
    // Add delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`  Found ${scheduledEvents.length} messages matching schedule`);
  return scheduledEvents;
}