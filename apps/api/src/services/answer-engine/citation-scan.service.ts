/**
 * Answer-engine citation scan — the per-store work (Task 6).
 *
 * `runCitationScan` is deliberately split OUT of the Inngest cron/on-demand
 * functions (mirrors `runDailyRollup` in `analytics-rollup.service.ts`) so
 * it's fully testable without a running Inngest server or a live LLM API:
 * tests inject mock `providers` + fixed `prompts` and assert on the
 * `AnswerEngineCheck` rows it writes.
 *
 * For each enabled provider (engine) × generated prompt:
 *   1. Budget guard (fail-soft, never throws) — see `budget.ts` for paid
 *      engines; Gemini's own `assertAiQuota()` lives inside
 *      `gemini.provider.ts`'s `query()`.
 *   2. `provider.query(storeId, prompt.text)` → raw `EngineAnswer`.
 *   3. `detectCitation(store, answer)` → citation verdict (already hardened
 *      against untrusted third-party LLM output — never re-parsed here).
 *   4. Write one `AnswerEngineCheck` row.
 *
 * FAIL-SOFT CONTRACT (money/quota path — binding):
 *   - A paid engine already over its daily cap is skipped ENTIRELY for this
 *     run (checked once up front, AND re-checked before every subsequent
 *     prompt so a mid-run cap trip can't fire the remaining prompts) — no
 *     calls, no spend, bounded overshoot.
 *   - A provider that throws (including an `isAiQuotaCapError` — the
 *     platform-wide Gemini request-cap AppError) stops ONLY that engine's
 *     remaining prompts for this store; every other engine still runs.
 *   - An `AnswerEngineCheck` write that throws (DB/RLS infra error) is caught
 *     per-prompt and logged — it does NOT stop the engine; the scan
 *     continues to the next prompt (and the next engine).
 *   - Nothing thrown by a provider, a budget check, or a write ever
 *     propagates out of `runCitationScan` — the whole store's scan always
 *     completes.
 */
import { withStore } from '@ebda/database';
import { storeDb, storeWriter } from '../../lib/repo-factory';
import logger from '../../lib/logger';
import { isAiQuotaCapError } from '../../lib/ai-quota';
import { recordUsage } from '../ai.service';
import { getEnabledProviders } from './registry';
import { generatePrompts, type GeneratedPrompt } from './prompts';
import { detectCitation, type AnswerEngineProvider } from './provider';
import { isPaidEngineOverBudget } from './budget';
import { withSavepoint } from '../../lib/savepoint';

export interface CitationScanEngineResult {
  engine: string;
  checks: number;
  skipped?: 'budget_cap_reached' | 'quota_cap_reached' | 'provider_error';
  /** Count of prompts where the `AnswerEngineCheck` write itself failed
   * (DB/RLS infra error) — logged and skipped rather than aborting the rest
   * of this engine's prompts (fail-soft contract, see the module header). */
  writeErrors?: number;
  /** Checks written from an UNGROUNDED fallback (the engine could not run
   * search grounding — `groundingUnavailableReason` set). Summed by the
   * weekly cron, which alerts when any occur (issue 2119). */
  ungrounded?: number;
}

export interface RunCitationScanOptions {
  /** Injectable for tests — defaults to `getEnabledProviders()` (real Gemini +
   * any admin-enabled, keyed paid engines). Tests pass mock providers so no
   * live API is ever called. */
  providers?: AnswerEngineProvider[];
  /** Injectable for tests — defaults to `generatePrompts(storeId)`. */
  prompts?: GeneratedPrompt[];
  /**
   * Start of the Inngest run this scan belongs to, memoized in its own step so
   * it is identical across step retries (#910). When set, an engine × prompt
   * that already has an `AnswerEngineCheck` row at or after this instant is
   * NOT re-queried: a step that crashed after writing 3 of 8 rows resumes at
   * row 4 instead of re-issuing 3 paid provider calls and duplicating 3 rows.
   * Omitted (tests, ad-hoc callers) = no resume, every pair is queried.
   */
  runStartedAt?: Date;
}

function checkKey(engine: string, promptText: string, locale: string): string {
  return JSON.stringify([engine, promptText, locale]);
}

// Paid engines (perplexity/openai) are the only ones that need a
// `aiUsage`-recorded feature key for the budget cap in `budget.ts`. Kept as
// an explicit map (rather than a template-literal cast) so an unrecognized
// engine name degrades to "don't record usage" instead of writing a
// `feature` value the budget guard doesn't know how to count.
function paidEngineFeature(
  engine: string
): 'answer_engine_perplexity' | 'answer_engine_openai' | null {
  if (engine === 'perplexity') return 'answer_engine_perplexity';
  if (engine === 'openai') return 'answer_engine_openai';
  return null;
}

export async function runCitationScan(
  storeId: string,
  opts: RunCitationScanOptions = {}
): Promise<CitationScanEngineResult[]> {
  const providers = opts.providers ?? (await getEnabledProviders());
  const prompts = opts.prompts ?? (await generatePrompts(storeId));

  // Loaded once and reused for every provider × prompt — detectCitation
  // only needs the domain (+ name-as-brand fallback for a brand mention).
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { domain: true, name: true },
    })
  );
  const citationStore = { domain: store?.domain ?? null, brand: store?.name };

  // Pairs this run already answered before a step retry (#910). One read per
  // store scan, bounded by engines × prompts rows.
  const alreadyChecked = new Set<string>();
  if (opts.runStartedAt) {
    const prior = await (
      await storeDb(storeId)
    ).answerEngineCheck.findMany({
      where: { storeId, runAt: { gte: opts.runStartedAt } },
      select: { engine: true, promptText: true, locale: true },
    });
    for (const row of prior) alreadyChecked.add(checkKey(row.engine, row.promptText, row.locale));
  }

  const results: CitationScanEngineResult[] = [];

  for (const provider of providers) {
    const isPaidEngine = provider.engine !== 'gemini';

    if (isPaidEngine && (await isPaidEngineOverBudget(provider.engine))) {
      logger.info(
        { storeId, engine: provider.engine },
        'answer-engine citation scan: paid engine over its daily budget cap, skipping'
      );
      results.push({ engine: provider.engine, checks: 0, skipped: 'budget_cap_reached' });
      continue;
    }

    let checks = 0;
    let writeErrors = 0;
    let ungrounded = 0;
    let skipped: CitationScanEngineResult['skipped'];

    for (const prompt of prompts) {
      // #910: written by an earlier attempt of this same run — count it, and
      // spend neither a provider call nor a second row on it.
      if (alreadyChecked.has(checkKey(provider.engine, prompt.text, prompt.locale))) {
        checks += 1;
        continue;
      }

      // M3: re-check the paid-engine budget before EACH call, not just once
      // up front. The initial check above stops a run that's ALREADY over
      // budget from starting; this recheck stops a run that TRIPS the cap
      // partway through (a prior prompt's `recordUsage` pushed it over) from
      // firing the remaining prompts — bounding overshoot to at most one
      // extra call instead of prompts−1.
      if (isPaidEngine && (await isPaidEngineOverBudget(provider.engine))) {
        skipped = 'budget_cap_reached';
        logger.info(
          { storeId, engine: provider.engine },
          'answer-engine citation scan: paid engine hit its daily budget cap mid-run, stopping this engine for this store'
        );
        break;
      }

      let answer;
      try {
        answer = await provider.query(storeId, prompt.text);
      } catch (err) {
        if (isAiQuotaCapError(err)) {
          skipped = 'quota_cap_reached';
          logger.info(
            { storeId, engine: provider.engine },
            'answer-engine citation scan: AI quota cap reached, stopping this engine for this store'
          );
        } else {
          skipped = 'provider_error';
          logger.warn(
            { err, storeId, engine: provider.engine },
            'answer-engine citation scan: provider threw, skipping this engine for this store'
          );
        }
        break;
      }

      // M4: the write path (detectCitation + the AnswerEngineCheck insert)
      // is wrapped in its own try/catch so a DB/RLS infra error on ONE
      // prompt's write doesn't throw out of `runCitationScan` and abort the
      // rest of this engine's prompts (or the store's other engines) —
      // matching the same fail-soft guarantee the provider-call catch above
      // already gives the LLM call itself.
      try {
        const citation = detectCitation(citationStore, answer);

        // Savepointed: the scan runs inside `runInTenantContext`'s single
        // transaction and this catch swallows (issue 2215's class) — one
        // failed write must not abort the rest of the scan's writes.
        const checkWriter = await storeWriter(storeId);
        await withSavepoint(() =>
          checkWriter.answerEngineCheck.create({
            data: {
              storeId,
              engine: provider.engine,
              promptText: prompt.text,
              locale: prompt.locale,
              cited: citation.cited,
              rank: citation.rank,
              snippet: citation.snippet,
              citedUrls: answer.citedUrls ?? [],
              competitorUrls: citation.competitorUrls,
              groundingUnavailableReason: answer.groundingUnavailableReason ?? null,
            },
          })
        );
        checks += 1;
        if (answer.groundingUnavailableReason) ungrounded += 1;

        if (isPaidEngine) {
          const feature = paidEngineFeature(provider.engine);
          if (feature) {
            await recordUsage(storeId, feature, 0, 0, false, {
              ...(provider.modelId ? { model: provider.modelId } : {}),
            });
          }
        }
      } catch (err) {
        writeErrors += 1;
        logger.warn(
          { err, storeId, engine: provider.engine, promptText: prompt.text },
          'answer-engine citation scan: AnswerEngineCheck write failed (infra error), skipping this prompt and continuing'
        );
        continue;
      }
    }

    results.push({
      engine: provider.engine,
      checks,
      ...(skipped ? { skipped } : {}),
      ...(writeErrors ? { writeErrors } : {}),
      ...(ungrounded ? { ungrounded } : {}),
    });
  }

  return results;
}
