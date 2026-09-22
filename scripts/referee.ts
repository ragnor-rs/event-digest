/**
 * Grades reasoning-effort experiment arms using a stronger referee model.
 *
 *   npx ts-node scripts/referee.ts grade <arm> [...arms]
 *   npx ts-node scripts/referee.ts compare <armA> <armB>
 *   npx ts-node scripts/referee.ts metrics <arm> [...arms]
 *
 * `grade`   — steps 3-6. The referee sees the source message and a decision and
 *             judges whether the decision is right. It is never told which arm
 *             produced it, so it cannot favour one systematically.
 * `compare` — step 7 only. Generative output scores poorly on absolute scales,
 *             so arms are compared pairwise with the presentation order flipped
 *             on alternate items to cancel position bias.
 * `metrics` — no API calls. Counts how often each prompt workaround fired, which
 *             is what decides whether the prompt defences can be deleted.
 *
 * Arms are read from eval/arms/<arm>/, written by scripts/run-arm.sh.
 */

import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';

dotenv.config();

import OpenAI from 'openai';

/** Stronger than the pipeline model, but not the flagship: these are short judgements. */
const REFEREE_MODEL = 'gpt-6-sol';
const REFEREE_EFFORT = 'medium';

/** How many items per step to grade. Steps narrow as the funnel narrows. */
const SAMPLE_SIZES: Record<string, number> = {
  event_detection: 150,
  event_classification: 100,
  schedule_filtering: 100,
  interest_matching: 80,
};

const ARMS_DIR = path.join(process.cwd(), 'eval', 'arms');

const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (see .env.example)`);
  }
  return value;
}

function readArmFile(arm: string, file: string): any {
  const filePath = path.join(ARMS_DIR, arm, `${file}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Run scripts/run-arm.sh ${arm} first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Deterministic sample: every arm must grade the SAME items, otherwise the
 * comparison measures which items were drawn rather than which arm is better.
 * Sorting by message link and striding gives a stable, spread-out subset.
 */
function sample<T>(items: T[], size: number, keyOf: (item: T) => string): T[] {
  if (items.length <= size) return items;
  const sorted = [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const stride = sorted.length / size;
  return Array.from({ length: size }, (_, i) => sorted[Math.floor(i * stride)]);
}

async function ask(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: REFEREE_MODEL,
    messages: [{ role: 'user', content: prompt }],
    reasoning_effort: REFEREE_EFFORT,
  });
  return response.choices[0].message.content?.trim() ?? '';
}

/** Runs judgements with bounded concurrency so a 150-item step is not serial. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const VERDICT_RULE =
  'Answer with exactly one word on the first line: CORRECT if the decision is defensible, ' +
  'WRONG if it is not. On a second line give a short reason. If the message is genuinely ' +
  'ambiguous, answer CORRECT — only call a decision WRONG when it is clearly mistaken.';

function truncate(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Builds the blind grading prompt for one entry of a given step. */
function gradingPrompt(step: string, entry: any): string {
  switch (step) {
    case 'event_detection':
      return `A filter decides whether a chat message announces one specific, real event (a talk, meetup, concert, workshop...). Recurring services, ads without a date, and general chatter are not events.

Message:
"""
${truncate(entry.messageContent ?? '')}
"""

The filter decided: ${entry.isEvent ? 'IS an event announcement' : 'is NOT an event announcement'}.

${VERDICT_RULE}`;

    case 'event_classification':
      return `A classifier labels an event as offline (physical venue), online (virtual only), or hybrid (both).

Message:
"""
${truncate(entry.message?.content ?? '')}
"""

The classifier decided: ${entry.type_classifications?.map((t: any) => t.type).join(', ') || 'none'}.

${VERDICT_RULE}`;

    case 'schedule_filtering':
      return `An extractor reads an event message and returns the event's start date and time, or "unknown".

Message posted at ${entry.message?.timestamp}:
"""
${truncate(entry.message?.content ?? '')}
"""

The extractor returned: ${entry.extracted_datetime}

Judge only whether that start datetime matches the message. Relative dates resolve against the posting timestamp above.

${VERDICT_RULE}`;

    case 'interest_matching':
      return `A matcher tags an event with the user interests it is relevant to.

Message:
"""
${truncate(entry.message?.content ?? '')}
"""

The matcher tagged: ${entry.interest_matches?.map((m: any) => m.interest).join(', ') || '(no interests — event dropped)'}

Judge whether these tags are relevant to the event. Extra loosely-related tags are acceptable; clearly unrelated tags are not.

${VERDICT_RULE}`;

    default:
      throw new Error(`Unknown step: ${step}`);
  }
}

function entriesOf(step: string, data: any): any[] {
  const list: any[] = data.results ?? data.entries ?? [];
  // Cached entries carry '[CACHED]' placeholders instead of real AI output, so
  // they say nothing about the arm being graded.
  return list.filter((e) => !e.cached);
}

function keyOf(step: string, entry: any): string {
  return step === 'event_detection' ? entry.messageLink : (entry.message?.link ?? '');
}

async function grade(arms: string[]): Promise<void> {
  for (const arm of arms) {
    console.log(`\n=== grading arm: ${arm} (referee: ${REFEREE_MODEL}, effort ${REFEREE_EFFORT}) ===`);
    const scorecard: Record<string, any> = {};

    for (const step of Object.keys(SAMPLE_SIZES)) {
      const entries = entriesOf(step, readArmFile(arm, step));
      if (entries.length === 0) {
        console.log(`  ${step.padEnd(22)} no uncached entries — skipped`);
        continue;
      }

      const picked = sample(entries, SAMPLE_SIZES[step], (e) => keyOf(step, e));
      const verdicts = await mapWithConcurrency(picked, 6, async (entry) => {
        const answer = await ask(gradingPrompt(step, entry));
        const correct = answer.toUpperCase().startsWith('CORRECT');
        return { key: keyOf(step, entry), correct, answer };
      });

      const correct = verdicts.filter((v) => v.correct).length;
      const rate = correct / verdicts.length;
      scorecard[step] = {
        graded: verdicts.length,
        correct,
        accuracy: Number(rate.toFixed(3)),
        wrong: verdicts.filter((v) => !v.correct),
      };
      console.log(`  ${step.padEnd(22)} ${correct}/${verdicts.length} correct (${(rate * 100).toFixed(1)}%)`);
    }

    const out = path.join(ARMS_DIR, arm, 'scorecard.json');
    fs.writeFileSync(out, JSON.stringify(scorecard, null, 2));
    console.log(`  -> ${out}`);
  }
}

async function compare(armA: string, armB: string): Promise<void> {
  console.log(`\n=== step 7 pairwise: ${armA} vs ${armB} ===`);

  const indexByLink = (arm: string) => {
    const map = new Map<string, any>();
    for (const entry of entriesOf('event_description', readArmFile(arm, 'event_description'))) {
      map.set(entry.message?.link, entry);
    }
    return map;
  };

  const a = indexByLink(armA);
  const b = indexByLink(armB);
  const shared = [...a.keys()].filter((link) => b.has(link)).sort();

  if (shared.length === 0) {
    console.log('  No events present in both arms — nothing to compare.');
    return;
  }

  const verdicts = await mapWithConcurrency(shared, 6, async (link, i) => {
    // Alternate which arm is shown first so position bias cancels out.
    const aFirst = i % 2 === 0;
    const first = aFirst ? a.get(link) : b.get(link);
    const second = aFirst ? b.get(link) : a.get(link);

    const answer =
      await ask(`Two systems each wrote a title and summary for the same event. Judge which is the better digest entry: accurate to the message, specific, and readable. Summaries should not restate the date or time.

Event message:
"""
${truncate(first.message?.content ?? '')}
"""

Option 1:
TITLE: ${first.extracted_title}
SUMMARY: ${first.extracted_summary}

Option 2:
TITLE: ${second.extracted_title}
SUMMARY: ${second.extracted_summary}

Answer with exactly one word: 1, 2, or TIE.`);

    const choice = answer.trim().toUpperCase();
    if (choice.startsWith('TIE')) return 'tie';
    if (choice.startsWith('1')) return aFirst ? armA : armB;
    if (choice.startsWith('2')) return aFirst ? armB : armA;
    return 'unparsed';
  });

  const tally = verdicts.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`  compared ${shared.length} events`);
  for (const [winner, count] of Object.entries(tally).sort((x, y) => y[1] - x[1])) {
    console.log(`    ${winner.padEnd(12)} ${count} (${((count / shared.length) * 100).toFixed(1)}%)`);
  }

  const out = path.join(ARMS_DIR, `compare_${armA}_vs_${armB}.json`);
  fs.writeFileSync(out, JSON.stringify({ armA, armB, compared: shared.length, tally }, null, 2));
  console.log(`  -> ${out}`);
}

/**
 * Counts how often each prompt workaround actually fired. These are the numbers
 * that decide whether a prompt defence can be removed — no referee needed.
 */
function metrics(arms: string[]): void {
  // normalizeDateTime() repairs "06 Sep 2025 18" into "...18:00". If the model
  // never emits the short form, the prompt's "NEVER return just a time" block
  // has nothing left to prevent.
  const shortDatePattern = /^\d{2} \w{3} \d{4} \d{2}$/m;

  for (const arm of arms) {
    console.log(`\n=== workaround trigger rates: ${arm} ===`);

    const description = entriesOf('event_description', readArmFile(arm, 'event_description'));
    const failed = description.filter((e) => !e.extraction_success).length;
    console.log(
      `  step 7 block/field extraction failures : ${failed}/${description.length}` +
        (description.length ? ` (${((failed / description.length) * 100).toFixed(1)}%)` : '')
    );

    const schedule = entriesOf('schedule_filtering', readArmFile(arm, 'schedule_filtering'));
    const repaired = schedule.filter((e) => shortDatePattern.test(e.ai_response ?? '')).length;
    console.log(
      `  step 5 responses needing date repair   : ${repaired}/${schedule.length}` +
        (schedule.length ? ` (${((repaired / schedule.length) * 100).toFixed(1)}%)` : '')
    );

    // The matcher drops interest indices the model invented. The run log records
    // each occurrence; counting them says whether the guardrail still earns its keep.
    const logPath = path.join(ARMS_DIR, arm, 'run.log');
    if (fs.existsSync(logPath)) {
      const invalid = (fs.readFileSync(logPath, 'utf-8').match(/invalid interest indices/g) ?? []).length;
      console.log(`  step 6 hallucinated interest indices   : ${invalid} occurrence(s)`);
    } else {
      console.log(`  step 6 hallucinated interest indices   : run.log missing — skipped`);
    }
  }
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);

  switch (mode) {
    case 'grade':
      if (rest.length === 0) throw new Error('usage: referee.ts grade <arm> [...arms]');
      await grade(rest);
      break;
    case 'compare':
      if (rest.length !== 2) throw new Error('usage: referee.ts compare <armA> <armB>');
      await compare(rest[0], rest[1]);
      break;
    case 'metrics':
      if (rest.length === 0) throw new Error('usage: referee.ts metrics <arm> [...arms]');
      metrics(rest);
      break;
    default:
      console.log(
        'usage:\n' +
          '  npx ts-node scripts/referee.ts grade   <arm> [...arms]   # steps 3-6, blind\n' +
          '  npx ts-node scripts/referee.ts compare <armA> <armB>     # step 7, pairwise\n' +
          '  npx ts-node scripts/referee.ts metrics <arm> [...arms]   # workaround trigger rates, no API calls'
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
