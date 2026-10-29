import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../../lib/repo-factory';
import { prisma, runInStoreScope, withStore } from '@ebda/database';
import { GeminiFailoverClient } from '../../ai/gemini-keys';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { sanitizeJsonControlChars } from '../../ai/parse-ai-json';
import { rethrowAsAppError } from '../../ai/gemini-errors';
import { recordUsage } from '../../../services/ai.service';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { buildMetaAeoPrompt, generateProductMetaAeo } from '../../ai/product-meta-aeo-generator';
import { invalidateStoreProductCaches } from '../../public-cache';
import { bustStoreCachesById } from '../../../services/store.service';
import { isPlaceholderText } from '../../ai/placeholder-guard';
import { EGYPTIAN_ARABIC_REGISTER } from '../../ai/arabic-register';
import { storeUpdate } from '../../repo-factory';

const AI_UNAVAILABLE_MESSAGE = 'AI request failed — please try again shortly.';

/**
 * AEO (Answer Engine Optimisation) bulk sweeps — drafts FAQ items,
 * HowTo guides, and conversational meta descriptions for a store
 * using Gemini, then persists them with smart-skip so merchant-edited
 * entries are never overwritten.
 *
 * Three Inngest functions registered here:
 *   bulk-ai-faq-aeo      — draft up to 8 store-level FAQ items
 *   bulk-ai-howto-aeo    — draft up to 3 HowTo guides
 *   bulk-ai-meta-aeo     — rewrite store + product + category meta
 *                          descriptions in conversational direct-answer style
 *
 * All three follow the same patterns as bulk-ai-seo and
 * bulk-ai-translate:
 *   - Throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - Abort on AI_DAILY_REQUEST_CAP / AI_MONTHLY_REQUEST_CAP
 *   - Cap error list at 50 so no single run bloats the row unboundedly
 *   - Mark BulkAiJob completed regardless — quotaReached is surfaced
 *     via the error list so the merchant sees actionable feedback
 *
 * PR2 — crash-resumable steps. `bulk-ai-faq-aeo` / `bulk-ai-howto-aeo` each
 * make a SINGLE Gemini call for the whole store (count is small, 3-8 items)
 * — there's nothing to batch, so the whole fetch+generate+persist body is
 * wrapped in one `step.run('generate-and-persist', ...)`: if the function
 * crashes AFTER that step completes (e.g. during the final job-completion
 * write), a retry skips straight past it instead of re-spending the Gemini
 * call. `bulk-ai-meta-aeo` DOES loop over every product + category, so it
 * gets full batching: `step.run('load-items', ...)` loads a stable
 * `{kind, id}` work-item list, split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)` —
 * a crash mid-sweep resumes at the first unfinished batch, and each item's
 * current AEO field is re-read fresh at batch time (idempotency re-check).
 */

// -----------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------

const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const ERROR_CAP = 50;
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getGenAI(): GeminiFailoverClient {
  if (!config.googleAiKey) {
    throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
  }
  return new GeminiFailoverClient();
}

/**
 * Strip Markdown code fences that Gemini occasionally emits even when
 * responseMimeType is set to application/json. Defensive — most calls
 * are clean.
 */
function stripFences(text: string): string {
  let s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Extract the outermost JSON span. Gemini occasionally appends explanatory
  // text after a valid JSON body even when prompted for pure JSON — e.g.
  // `{"en": "..."}\n\nNote: this is a draft.` That trailing text trips
  // JSON.parse with "Unexpected non-whitespace character after JSON at
  // position N" (verified failure: meta-aeo sweep on products Mastic + caraway
  // at position 331, 2026-05-25). Same trap on the leading side
  // ("Here's the JSON:\n{...}").
  //
  // Strategy: slice from the first `{` or `[` to the last `}` or `]`.
  // Not fully bracket-balanced (JSON with `{` inside a string literal is
  // fine because lastIndexOf finds the OUTER closer), but covers every
  // real Gemini response shape observed in prod.
  const firstOpen = s.search(/[\{\[]/);
  if (firstOpen > 0) s = s.slice(firstOpen);

  const lastClose = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastClose !== -1 && lastClose < s.length - 1) {
    s = s.slice(0, lastClose + 1);
  }

  return s;
}

/**
 * Auto-enable a footer "support" link for the store after a bulk-AI
 * sweep populates the underlying content. Two real-world traps this
 * closes:
 *
 *   1. The merchant's footerLinks default has the FAQ row with
 *      `enabled: false` (hide-when-empty default — see
 *      the CMS/tenant-control notes). Once the sweep
 *      writes 8 FAQs, the link should obviously turn on; without
 *      this helper it stays hidden until the merchant manually
 *      toggles it in admin.
 *   2. /how-to-guides isn't in the default footerLinks shape at all
 *      (added 2026-05-13). For stores provisioned before then, the
 *      row simply doesn't exist — this appends it.
 *
 * The whole operation is a no-op when the link is already correctly
 * configured (enabled + present), so re-running the sweep doesn't
 * re-toggle anything. Safe to call on every sweep completion (including
 * a memoized-step retry — it's a plain idempotent read+conditional-write,
 * not a Gemini call).
 */
async function ensureFooterSupportLinkEnabled(
  storeId: string,
  href: string,
  defaultName: string,
  defaultNameAr: string
): Promise<void> {
  try {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { settings: true },
      })
    );
    if (!store) return;

    const settings = (store.settings ?? {}) as Record<string, unknown>;
    const footerLinks = (settings.footerLinks ?? {}) as Record<string, unknown>;
    const supportRaw = footerLinks.support;
    const support = Array.isArray(supportRaw)
      ? (supportRaw as Array<{
          href?: string;
          name?: string;
          nameAr?: string;
          enabled?: boolean;
        }>)
      : [];

    const existingIdx = support.findIndex(e => e?.href === href);
    let mutated = false;

    if (existingIdx >= 0) {
      const current = support[existingIdx];
      const needsEnable = current?.enabled !== true;
      const needsNameAr = !current?.nameAr;
      if (needsEnable || needsNameAr) {
        support[existingIdx] = {
          ...current,
          enabled: true,
          ...(needsNameAr && { nameAr: defaultNameAr }),
        };
        mutated = true;
      }
    } else {
      support.push({ href, name: defaultName, nameAr: defaultNameAr, enabled: true });
      mutated = true;
    }

    if (!mutated) return;

    const nextSettings = {
      ...settings,
      footerLinks: { ...footerLinks, support },
    };

    await withStore(storeId, tx =>
      storeUpdate(tx, {
        where: { id: storeId },
        data: { settings: nextSettings },
      })
    );

    logger.info(
      { storeId, href, defaultName },
      'bulk-ai-aeo: enabled footer support link after content sweep'
    );
  } catch (err) {
    logger.warn(
      { err, storeId, href },
      'bulk-ai-aeo: failed to auto-enable footer link (sweep still succeeded)'
    );
  }
}

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface DraftedFaq {
  question: string;
  questionAr: string;
  answer: string;
  answerAr: string;
}

export interface HowToStep {
  name: string;
  text: string;
}

export interface DraftedHowTo {
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  steps: HowToStep[];
  stepsAr: HowToStep[];
}

interface AeoErr {
  entityKind: string;
  entityId: string;
  entityName: string;
  error: string;
}

// -----------------------------------------------------------------------
// bulk-ai-faq-aeo — draft store-level FAQ items
// -----------------------------------------------------------------------

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const bulkAiFaqAeoFn = inngest.createFunction(
  {
    id: 'bulk-ai-faq-aeo',
    name: 'Bulk: draft AEO FAQ items for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/faq-aeo-requested' }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      storeId,
      count = 8,
      force = false,
    } = event.data as {
      jobId: string;
      storeId: string;
      count?: number;
      force?: boolean;
    };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/faq-aeo-requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date(), total: count, force },
        })
      );

      const result = await runFaqAeoStep();
      async function runFaqAeoStep(): Promise<{
        notFound: boolean;
        filled: number;
        skipped: number;
        failed: number;
        errors: AeoErr[];
        quotaReached?: boolean;
      }> {
        try {
          return await step.run('generate-and-persist', () => generateAndPersistFaqs());
        } catch (err) {
          if (!isAiQuotaCapError(err)) throw err;
          return {
            notFound: false,
            filled: 0,
            skipped: 0,
            failed: 0,
            errors: [
              {
                entityKind: 'store',
                entityId: storeId,
                entityName: 'sweep',
                error: err instanceof AppError ? err.message : 'AI quota cap reached',
              },
            ],
            quotaReached: true,
          };
        }
      }

      async function generateAndPersistFaqs() {
        const errors: AeoErr[] = [];
        let filled = 0;
        let skipped = 0;
        let failed = 0;

        const [store, sampleCats, sampleProds, paymentConfigs] = await Promise.all([
          prisma.store.findUnique({
            where: { id: storeId },
            select: { name: true, nameAr: true, description: true },
          }),
          prisma.category.findMany({
            where: { storeId, isActive: true },
            select: { name: true },
            take: 10,
          }),
          prisma.product.findMany({
            where: { storeId, status: 'active', deletedAt: null },
            select: { name: true },
            take: 20,
          }),
          prisma.paymentConfig.findMany({
            where: { storeId, isEnabled: true },
            select: { provider: true, supportedMethods: true },
          }),
        ]);

        if (!store) {
          return { notFound: true, filled, skipped, failed, errors };
        }

        const existingFaqs = await prisma.storeFaq.findMany({
          where: { storeId },
          select: { question: true, manuallyEdited: true, orderIndex: true },
        });
        const lockedQuestions = new Set(
          existingFaqs.filter(f => f.manuallyEdited).map(f => f.question.trim().toLowerCase())
        );
        let maxOrder = existingFaqs.reduce((m, f) => Math.max(m, f.orderIndex), -1);

        const catNames = sampleCats.map(c => c.name).join(', ') || 'none';
        const prodNames =
          sampleProds
            .map(p => p.name)
            .join(', ')
            .slice(0, 500) || 'none';

        const PROVIDER_METHODS: Record<string, string[]> = {
          paymob: ['Visa', 'Mastercard', 'Meeza', 'Mobile wallets', 'valU installments'],
          kashier: ['Visa', 'Mastercard', 'Mobile wallets'],
          fawry: ['Pay at Fawry', 'Visa', 'Mastercard'],
          geidea: ['Visa', 'Mastercard'],
          instapay: ['InstaPay'],
          cod: ['Cash on Delivery'],
        };
        const methodSet = new Set<string>();
        for (const cfg of paymentConfigs) {
          const overrides = cfg.supportedMethods?.length ? cfg.supportedMethods : null;
          const list = overrides ?? PROVIDER_METHODS[cfg.provider] ?? [];
          for (const m of list) methodSet.add(m);
        }
        const paymentMethodsList =
          methodSet.size > 0 ? Array.from(methodSet).join(', ') : 'cash on delivery';

        if (force) {
          await prisma.storeFaq.deleteMany({
            where: { storeId, manuallyEdited: false },
          });
          const reloadedFaqs = await prisma.storeFaq.findMany({
            where: { storeId },
            select: { question: true, manuallyEdited: true, orderIndex: true },
          });
          lockedQuestions.clear();
          for (const f of reloadedFaqs) {
            if (f.manuallyEdited) lockedQuestions.add(f.question.trim().toLowerCase());
          }
          maxOrder = reloadedFaqs.reduce((m, f) => Math.max(m, f.orderIndex), -1);
          logger.info({ jobId, storeId }, 'bulk-ai-faq-aeo: cleared non-manual FAQs (force=true)');
        }

        const prompt = `You are an SEO + AEO expert helping an Egypt-based e-commerce store author its FAQ page.

Store name: "${store.name}"${store.nameAr ? ` / "${store.nameAr}"` : ''}
Description: ${store.description ?? 'Not provided.'}
Sample categories: ${catNames}
Sample products: ${prodNames}

Draft exactly ${count} FAQs that real customers in Egypt would ask. Cover:
- Delivery / shipping (Egypt city, governorates, GCC)
- Payment methods. This store accepts EXACTLY: ${paymentMethodsList}. List those method names; do NOT name payment-gateway companies (Paymob, Kashier) — customers pick Visa / Mastercard / Meeza / a mobile wallet / Pay at Fawry / InstaPay, they don't know which back-end gateway processes them.
- Returns and exchanges policy
- Product care / usage relevant to this store's category
- Store hours / how to contact support
- Bulk or wholesale orders (if relevant)
- Sizing or specs (if relevant)
- Loyalty programs or discount codes

Each FAQ: a clear, specific question + a concise 2-3 sentence answer. Both in English AND in Arabic. ${EGYPTIAN_ARABIC_REGISTER}

Return ONLY a JSON array. Each element must have exactly these keys:
  question, questionAr, answer, answerAr
No other text, no markdown code fences — pure JSON only.`;

        await assertAiQuota({ storeId, bulk: true });

        const genAI = getGenAI();
        const model = genAI.getGenerativeModel({
          model: MODEL,
          generationConfig: { responseMimeType: 'application/json' },
        });

        let drafted: DraftedFaq[] = [];
        try {
          const genResult = await callWithRetry(
            () => model.generateContent(prompt),
            `faq-aeo:${storeId}`
          ).catch((err: unknown) => rethrowAsAppError(err, 'AI FAQ AEO sweep failed'));
          const usage = genResult.response.usageMetadata;
          await recordUsage(
            storeId,
            'aeo',
            usage?.promptTokenCount ?? 0,
            usage?.candidatesTokenCount ?? 0,
            false
          );
          const raw = sanitizeJsonControlChars(stripFences(genResult.response.text()));
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array');
          drafted = parsed.slice(0, count);
        } catch (err) {
          if (isAiQuotaCapError(err)) throw err;
          const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
          logger.error({ err, storeId, jobId }, 'bulk-ai-faq-aeo: Gemini error');
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: store.name,
              error: msg,
            });
          failed++;
        }

        await sleep(THROTTLE_MS);

        let orderCursor = maxOrder;
        for (const f of drafted) {
          if (!f.question?.trim() || !f.answer?.trim()) {
            skipped++;
            continue;
          }
          if (isPlaceholderText(f.question) || isPlaceholderText(f.answer)) {
            skipped++;
            continue;
          }
          if (lockedQuestions.has(f.question.trim().toLowerCase())) {
            skipped++;
            continue;
          }
          try {
            orderCursor++;
            await prisma.storeFaq.create({
              data: {
                storeId,
                question: f.question.trim(),
                questionAr: f.questionAr?.trim() || null,
                answer: f.answer.trim(),
                answerAr: f.answerAr?.trim() || null,
                aiDrafted: true,
                manuallyEdited: false,
                orderIndex: orderCursor,
              },
            });
            filled++;
          } catch (err) {
            if (errors.length < ERROR_CAP) {
              errors.push({
                entityKind: 'faq',
                entityId: storeId,
                entityName: f.question.slice(0, 80),
                error: err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE,
              });
            }
            failed++;
          }
        }

        return { notFound: false, filled, skipped, failed, errors };
      }

      if (result.notFound) {
        await step.run('mark-failed', async () => {
          await prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
        });
        return;
      }

      const quotaReached = 'quotaReached' in result && result.quotaReached === true;

      // Bust ONCE per sweep, never per item. This file defines THREE separate
      // Inngest functions; an earlier pass inserted the bust before only the LAST
      // completion block in the file, so two of the three sweeps still wrote
      // store-facing content and invalidated nothing — and what they invalidated
      // (invalidateStoreProductCaches, the `public:products:*` prefix) was the
      // wrong namespace anyway: StoreFaq rows are served off the STORE record's
      // own `public:store:*` cache keys (public.routes.ts's
      // fetchStoreFaqsAndHowtos, embedded in the `public:store:<slugOrId>` and
      // `public:store:resolve:<domain>` payloads), never off `public:products:*`
      // (#1333).
      await step.run('bust-store-caches', () => bustStoreCachesById(storeId));
      await step.run('finalize', async () => {
        const faqFinalRow = await prisma.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: faqFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
            processed: result.filled + result.skipped + result.failed,
            filled: result.filled,
            skipped: result.skipped,
            failed: result.failed,
            errors: result.errors as object,
            completedAt: new Date(),
          },
        });
      });

      if (result.filled > 0) {
        await step.run('ensure-footer-link', async () => {
          await ensureFooterSupportLinkEnabled(storeId, '/faq', 'FAQ', 'الأسئلة الشائعة');
        });
      }

      logger.info(
        {
          jobId,
          storeId,
          filled: result.filled,
          skipped: result.skipped,
          failed: result.failed,
          quotaReached,
        },
        'bulk-ai-faq-aeo complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiFaqAeo: JobDef = bulkAiFaqAeoFn;

// -----------------------------------------------------------------------
// bulk-ai-howto-aeo — draft HowTo guides
// -----------------------------------------------------------------------

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const bulkAiHowtoAeoFn = inngest.createFunction(
  {
    id: 'bulk-ai-howto-aeo',
    name: 'Bulk: draft AEO HowTo guides for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/howto-aeo-requested' }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      storeId,
      count = 3,
      force = false,
    } = event.data as {
      jobId: string;
      storeId: string;
      count?: number;
      force?: boolean;
    };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/howto-aeo-requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date(), total: count, force },
        })
      );

      const result = await runHowtoAeoStep();
      async function runHowtoAeoStep(): Promise<{
        notFound: boolean;
        filled: number;
        skipped: number;
        failed: number;
        errors: AeoErr[];
        quotaReached?: boolean;
      }> {
        try {
          return await step.run('generate-and-persist', () => generateAndPersistHowtos());
        } catch (err) {
          if (!isAiQuotaCapError(err)) throw err;
          return {
            notFound: false,
            filled: 0,
            skipped: 0,
            failed: 0,
            errors: [
              {
                entityKind: 'store',
                entityId: storeId,
                entityName: 'sweep',
                error: err instanceof AppError ? err.message : 'AI quota cap reached',
              },
            ],
            quotaReached: true,
          };
        }
      }

      async function generateAndPersistHowtos() {
        const errors: AeoErr[] = [];
        let filled = 0;
        let skipped = 0;
        let failed = 0;

        const [store, sampleCats, sampleProds] = await Promise.all([
          prisma.store.findUnique({
            where: { id: storeId },
            select: { name: true, nameAr: true, description: true },
          }),
          prisma.category.findMany({
            where: { storeId, isActive: true },
            select: { name: true },
            take: 8,
          }),
          prisma.product.findMany({
            where: { storeId, status: 'active', deletedAt: null },
            select: { name: true },
            take: 15,
          }),
        ]);

        if (!store) {
          return { notFound: true, filled, skipped, failed, errors };
        }

        const existingHowtos = await prisma.storeHowto.findMany({
          where: { storeId },
          select: { title: true, manuallyEdited: true, orderIndex: true },
        });
        const lockedTitles = new Set(
          existingHowtos.filter(h => h.manuallyEdited).map(h => h.title.trim().toLowerCase())
        );
        let maxOrder = existingHowtos.reduce((m, h) => Math.max(m, h.orderIndex), -1);

        if (force) {
          await prisma.storeHowto.deleteMany({
            where: { storeId, manuallyEdited: false },
          });
          const reloadedHowtos = await prisma.storeHowto.findMany({
            where: { storeId },
            select: { title: true, manuallyEdited: true, orderIndex: true },
          });
          lockedTitles.clear();
          for (const h of reloadedHowtos) {
            if (h.manuallyEdited) lockedTitles.add(h.title.trim().toLowerCase());
          }
          maxOrder = reloadedHowtos.reduce((m, h) => Math.max(m, h.orderIndex), -1);
          logger.info(
            { jobId, storeId },
            'bulk-ai-howto-aeo: cleared non-manual HowTos (force=true)'
          );
        }

        const catNames = sampleCats.map(c => c.name).join(', ') || 'none';
        const prodSample =
          sampleProds
            .slice(0, 8)
            .map(p => p.name)
            .join(', ') || 'none';

        const prompt = `You are an AEO (Answer Engine Optimisation) expert writing HowTo guides for an Egypt-based e-commerce store.

Store name: "${store.name}"${store.nameAr ? ` / "${store.nameAr}"` : ''}
Categories: ${catNames}
Sample products: ${prodSample}

Write exactly ${count} HowTo guides that help customers understand this store's processes or products. Suggested topics (pick the most relevant for this store type):
- How to place an order
- How to choose the right size / variant
- How to return or exchange an item
- How to track your delivery in Egypt
- How to care for [material/product type relevant to this store]
- How to use [a specific product or service]

For each guide:
- title: short, action-oriented (e.g. "How to Return an Item")
- titleAr: same in Arabic (${EGYPTIAN_ARABIC_REGISTER})
- description: 1-2 sentence overview
- descriptionAr: same in Arabic
- steps: 3-6 steps, each with "name" (short label) and "text" (1-2 sentence instruction)
- stepsAr: the same steps translated into Arabic

Return ONLY a JSON array. Each element must have exactly:
  title, titleAr, description, descriptionAr, steps, stepsAr
where steps and stepsAr are arrays of { name, text }.
No markdown, no code fences — pure JSON only.`;

        await assertAiQuota({ storeId, bulk: true });

        const genAI = getGenAI();
        const model = genAI.getGenerativeModel({
          model: MODEL,
          generationConfig: { responseMimeType: 'application/json' },
        });

        let drafted: DraftedHowTo[] = [];
        try {
          const genResult = await callWithRetry(
            () => model.generateContent(prompt),
            `howto-aeo:${storeId}`
          ).catch((err: unknown) => rethrowAsAppError(err, 'AI HowTo AEO sweep failed'));
          const usage = genResult.response.usageMetadata;
          await recordUsage(
            storeId,
            'aeo',
            usage?.promptTokenCount ?? 0,
            usage?.candidatesTokenCount ?? 0,
            false
          );
          const raw = sanitizeJsonControlChars(stripFences(genResult.response.text()));
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array');
          drafted = parsed.slice(0, count);
        } catch (err) {
          if (isAiQuotaCapError(err)) throw err;
          const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
          logger.error({ err, storeId, jobId }, 'bulk-ai-howto-aeo: Gemini error');
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: store.name,
              error: msg,
            });
          failed++;
        }

        await sleep(THROTTLE_MS);

        let orderCursor = maxOrder;
        for (const h of drafted) {
          if (
            !h.title?.trim() ||
            !h.description?.trim() ||
            !Array.isArray(h.steps) ||
            h.steps.length === 0
          ) {
            skipped++;
            continue;
          }
          if (isPlaceholderText(h.title) || isPlaceholderText(h.description)) {
            skipped++;
            continue;
          }
          if (lockedTitles.has(h.title.trim().toLowerCase())) {
            skipped++;
            continue;
          }
          try {
            orderCursor++;
            await prisma.storeHowto.create({
              data: {
                storeId,
                title: h.title.trim(),
                titleAr: h.titleAr?.trim() || null,
                description: h.description.trim(),
                descriptionAr: h.descriptionAr?.trim() || null,
                steps: h.steps as object,
                stepsAr: (h.stepsAr || []) as object,
                aiDrafted: true,
                manuallyEdited: false,
                orderIndex: orderCursor,
              },
            });
            filled++;
          } catch (err) {
            if (errors.length < ERROR_CAP) {
              errors.push({
                entityKind: 'howto',
                entityId: storeId,
                entityName: h.title.slice(0, 80),
                error: err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE,
              });
            }
            failed++;
          }
        }

        return { notFound: false, filled, skipped, failed, errors };
      }

      if (result.notFound) {
        await step.run('mark-failed', async () => {
          await prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
        });
        return;
      }

      const quotaReached = 'quotaReached' in result && result.quotaReached === true;

      // Bust ONCE per sweep, never per item — see the identical note on the
      // FAQ sweep above (#1333): StoreHowto rows are served off the STORE
      // record's own `public:store:*` cache keys, not `public:products:*`.
      await step.run('bust-store-caches', () => bustStoreCachesById(storeId));
      await step.run('finalize', async () => {
        const howtoFinalRow = await prisma.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: howtoFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
            processed: result.filled + result.skipped + result.failed,
            filled: result.filled,
            skipped: result.skipped,
            failed: result.failed,
            errors: result.errors as object,
            completedAt: new Date(),
          },
        });
      });

      if (result.filled > 0) {
        await step.run('ensure-footer-link', async () => {
          await ensureFooterSupportLinkEnabled(
            storeId,
            '/how-to-guides',
            'How-To Guides',
            'أدلة الاستخدام'
          );
        });
      }

      logger.info(
        {
          jobId,
          storeId,
          filled: result.filled,
          skipped: result.skipped,
          failed: result.failed,
          quotaReached,
        },
        'bulk-ai-howto-aeo complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiHowtoAeo: JobDef = bulkAiHowtoAeoFn;

// -----------------------------------------------------------------------
// bulk-ai-meta-aeo — rewrite meta descriptions in conversational style
// -----------------------------------------------------------------------

type MetaWorkItem = { kind: 'store' | 'category' | 'product'; id: string };

interface MetaBatchResult {
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errors: AeoErr[];
  quotaReached: boolean;
  cancelled: boolean;
}

/**
 * Rewrites metaDescriptionAeo (store + products + categories) to answer
 * "What is X?" style questions that answer engines like Perplexity or
 * Google AI Overview surface.
 *
 * Conservative default: only fill EMPTY metaDescriptionAeo fields so we
 * never stomp on a merchant who has written a custom one. `force` bypasses
 * the skip.
 */
// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const bulkAiMetaAeoFn = inngest.createFunction(
  {
    id: 'bulk-ai-meta-aeo',
    name: 'Bulk: rewrite meta descriptions in conversational AEO style',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/meta-aeo-requested' }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      storeId,
      force = false,
    } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/meta-aeo-requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date(), force },
        })
      );

      const items: MetaWorkItem[] = await step.run('load-items', async () => {
        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { id: true },
        });
        if (!store) return [];

        const products = await prisma.product.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });
        const cats = await prisma.category.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });

        const work: MetaWorkItem[] = [
          { kind: 'store', id: storeId },
          ...products.map(p => ({ kind: 'product' as const, id: p.id })),
          ...cats.map(c => ({ kind: 'category' as const, id: c.id })),
        ];

        await prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: work.length },
        });

        return work;
      });

      if (items.length === 0) {
        await step.run('mark-failed', async () => {
          await prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
        });
        return;
      }

      const store = await step.run('load-store', () =>
        prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true },
        })
      );
      const storeName = store?.name ?? storeId;

      const batches = chunk(items, BULK_AI_BATCH_SIZE);

      const errors: AeoErr[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      for (let i = 0; i < batches.length; i++) {
        const batchItems = batches[i];

        const result: MetaBatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await prisma.bulkAiJob.findUnique({
            where: { id: jobId, storeId },
            select: { status: true },
          });
          if (currentJob?.status === 'cancelled') {
            return {
              processed: 0,
              filled: 0,
              skipped: 0,
              failed: 0,
              errors: [],
              quotaReached: false,
              cancelled: true,
            };
          }

          const genAI = getGenAI();
          const model = genAI.getGenerativeModel({
            model: MODEL,
            generationConfig: { responseMimeType: 'application/json' },
          });

          let bProcessed = 0;
          let bFilled = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: AeoErr[] = [];

          for (const item of batchItems) {
            if (item.kind === 'store') {
              const s = await prisma.store.findUnique({
                where: { id: item.id },
                select: {
                  name: true,
                  description: true,
                  metaDescriptionAeo: true,
                  metaDescriptionAeoAr: true,
                },
              });
              if (!s) {
                bSkipped++;
                bProcessed++;
                continue;
              }
              if (!force && s.metaDescriptionAeo?.trim()) {
                bSkipped++;
                bProcessed++;
                continue;
              }
              try {
                await assertAiQuota({ storeId, bulk: true });
                const prompt = buildMetaAeoPrompt('store', s.name, s.description ?? '');
                const genResult = await callWithRetry(
                  () => model.generateContent(prompt),
                  `meta-aeo:store:${storeId}`
                ).catch((err: unknown) => rethrowAsAppError(err, 'AI store meta AEO sweep failed'));
                const usage = genResult.response.usageMetadata;
                await recordUsage(
                  storeId,
                  'aeo',
                  usage?.promptTokenCount ?? 0,
                  usage?.candidatesTokenCount ?? 0,
                  false
                );
                const raw = stripFences(genResult.response.text());
                const parsed = JSON.parse(raw) as { en: string; ar: string };
                if (
                  typeof parsed.en === 'string' &&
                  parsed.en.trim() &&
                  !isPlaceholderText(parsed.en)
                ) {
                  await storeUpdate(prisma, {
                    where: { id: storeId },
                    data: {
                      metaDescriptionAeo: parsed.en.trim().slice(0, 160),
                      metaDescriptionAeoAr:
                        parsed.ar?.trim().slice(0, 160) || s.metaDescriptionAeoAr || null,
                    },
                  });
                  bFilled++;
                } else {
                  bSkipped++;
                }
                await sleep(THROTTLE_MS);
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  bQuotaReached = true;
                  break;
                }
                const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
                logger.error({ err, storeId, jobId }, 'bulk-ai-meta-aeo: store meta error');
                if (bErrors.length < ERROR_CAP)
                  bErrors.push({
                    entityKind: 'store',
                    entityId: storeId,
                    entityName: s.name,
                    error: msg,
                  });
                bFailed++;
              }
              bProcessed++;
              continue;
            }

            if (item.kind === 'product') {
              const p = await prisma.product.findUnique({
                where: { id: item.id, storeId },
                select: {
                  id: true,
                  name: true,
                  description: true,
                  metaDescriptionAeo: true,
                  metaDescriptionAeoAr: true,
                },
              });
              if (!p) {
                bSkipped++;
                bProcessed++;
                continue;
              }
              if (!force && p.metaDescriptionAeo?.trim()) {
                bSkipped++;
                bProcessed++;
                continue;
              }
              try {
                await assertAiQuota({ storeId, bulk: true });
                // Shared core — identical prompt + parse + usage-recording
                // path as the per-product "Generate with AI" route
                // (POST /ai/product-meta-aeo). DRY: both call
                // generateProductMetaAeo so per-product and bulk AEO output
                // never diverge.
                const generated = await callWithRetry(
                  () =>
                    generateProductMetaAeo(
                      { storeId, storeName, product: { name: p.name, description: p.description } },
                      config.googleAiKey,
                      MODEL
                    ),
                  `meta-aeo:product:${p.id}`
                );
                if (generated.en && !isPlaceholderText(generated.en)) {
                  await (
                    await storeWriter(storeId)
                  ).product.update({
                    where: { id: p.id, storeId },
                    data: {
                      metaDescriptionAeo: generated.en,
                      metaDescriptionAeoAr: generated.ar || p.metaDescriptionAeoAr || null,
                    },
                  });
                  bFilled++;
                } else {
                  bSkipped++;
                }
                await sleep(THROTTLE_MS);
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  bQuotaReached = true;
                  break;
                }
                const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
                if (bErrors.length < ERROR_CAP)
                  bErrors.push({
                    entityKind: 'product',
                    entityId: p.id,
                    entityName: p.name,
                    error: msg,
                  });
                bFailed++;
              }
              bProcessed++;
              continue;
            }

            // item.kind === 'category'
            const c = await prisma.category.findUnique({
              where: { id: item.id, storeId },
              select: {
                id: true,
                name: true,
                description: true,
                metaDescriptionAeo: true,
                metaDescriptionAeoAr: true,
              },
            });
            if (!c) {
              bSkipped++;
              bProcessed++;
              continue;
            }
            if (!force && c.metaDescriptionAeo?.trim()) {
              bSkipped++;
              bProcessed++;
              continue;
            }
            try {
              await assertAiQuota({ storeId, bulk: true });
              const prompt = buildMetaAeoPrompt('category', c.name, c.description ?? '', storeName);
              const genResult = await callWithRetry(
                () => model.generateContent(prompt),
                `meta-aeo:category:${c.id}`
              ).catch((err: unknown) =>
                rethrowAsAppError(err, 'AI category meta AEO sweep failed')
              );
              const usage = genResult.response.usageMetadata;
              await recordUsage(
                storeId,
                'aeo',
                usage?.promptTokenCount ?? 0,
                usage?.candidatesTokenCount ?? 0,
                false
              );
              const raw = stripFences(genResult.response.text());
              const parsed = JSON.parse(raw) as { en: string; ar: string };
              if (
                typeof parsed.en === 'string' &&
                parsed.en.trim() &&
                !isPlaceholderText(parsed.en)
              ) {
                await (
                  await storeWriter(storeId)
                ).category.update({
                  where: { id: c.id, storeId },
                  data: {
                    metaDescriptionAeo: parsed.en.trim().slice(0, 160),
                    metaDescriptionAeoAr:
                      parsed.ar?.trim().slice(0, 160) || c.metaDescriptionAeoAr || null,
                  },
                });
                bFilled++;
              } else {
                bSkipped++;
              }
              await sleep(THROTTLE_MS);
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                bQuotaReached = true;
                break;
              }
              const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
              if (bErrors.length < ERROR_CAP)
                bErrors.push({
                  entityKind: 'category',
                  entityId: c.id,
                  entityName: c.name,
                  error: msg,
                });
              bFailed++;
            }
            bProcessed++;
          }

          return {
            processed: bProcessed,
            filled: bFilled,
            skipped: bSkipped,
            failed: bFailed,
            errors: bErrors,
            quotaReached: bQuotaReached,
            cancelled: false,
          };
        });

        processed += result.processed;
        filled += result.filled;
        skipped += result.skipped;
        failed += result.failed;
        for (const e of result.errors) {
          if (errors.length < ERROR_CAP) errors.push(e);
        }

        await step.run(`progress-${i}`, () =>
          prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { processed, filled, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, filled, skipped, failed },
            'bulk-ai-meta-aeo: cancelled by merchant'
          );
          break;
        }
        if (result.quotaReached) {
          quotaReached = true;
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: 'sweep',
              error: 'AI quota cap reached',
            });
          break;
        }
      }

      // A bulk AI sweep rewrites product-facing content (titles, descriptions,
      // SEO, translations, tags, categories, image alt, FAQs) with raw Prisma
      // writes that carry no cache awareness, so the storefront kept serving
      // the pre-sweep copy until the TTL expired. Bust ONCE at the end, never
      // per item — same discipline as bulk-import (a per-row sweep would be an
      // invalidation storm). This also purges the storefront's Next data cache
      // via the tag the public fetches carry.
      //
      // This sweep ALSO writes Store.metaDescriptionAeo/metaDescriptionAeoAr
      // (the store-level meta AEO fields, above), which is served off the
      // `public:store:*` keys, not `public:products:*` — #1333's audit missed
      // this site because its product-cache bust IS correct for the product/
      // category writes; it was simply incomplete for the store-level write
      // the same run makes. Bust both.
      await step.run('bust-product-caches', () => invalidateStoreProductCaches(storeId));
      await step.run('bust-store-caches', () => bustStoreCachesById(storeId));
      await step.run('finalize', async () => {
        const metaFinalRow = await prisma.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: metaFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
            processed,
            filled,
            skipped,
            failed,
            errors: errors as object,
            completedAt: new Date(),
          },
        });
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-meta-aeo complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiMetaAeo: JobDef = bulkAiMetaAeoFn;

// Prompt builder for conversational meta descriptions (store/product/category)
// now lives in lib/ai/product-meta-aeo-generator.ts as `buildMetaAeoPrompt` —
// shared with the per-product "Generate with AI" route so both surfaces stay
// in sync. Imported above as `buildMetaAeoPrompt`.
