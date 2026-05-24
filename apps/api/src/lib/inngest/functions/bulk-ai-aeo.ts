import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';

/**
 * AEO (Answer Engine Optimisation) bulk sweeps — drafts FAQ items,
 * HowTo guides, and conversational meta descriptions for a store
 * using Gemini, then persists them with smart-skip so merchant-edited
 * entries are never overwritten.
 *
 * Three Inngest functions registered here:
 *   bulk-ai-faq-aeo      — draft up to 8 store-level FAQ items
 *   bulk-ai-howto-aeo    — draft up to 3 HowTo guides
 *   bulk-ai-meta-aeo     — rewrite store + product meta descriptions
 *                          in conversational direct-answer style
 *
 * All three follow the same patterns as bulk-ai-seo and
 * bulk-ai-translate:
 *   - Throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - Abort on AI_DAILY_REQUEST_CAP / AI_MONTHLY_REQUEST_CAP
 *   - Cap error list at 50 so no single run bloats the row unboundedly
 *   - Mark BulkAiJob completed regardless — quotaReached is surfaced
 *     via the error list so the merchant sees actionable feedback
 */

// -----------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------

const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const ERROR_CAP = 50;
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getGenAI(): GoogleGenerativeAI {
  if (!config.googleAiKey) {
    throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
  }
  return new GoogleGenerativeAI(config.googleAiKey);
}

/**
 * Strip Markdown code fences that Gemini occasionally emits even when
 * responseMimeType is set to application/json. Defensive — most calls
 * are clean.
 */
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Auto-enable a footer "support" link for the store after a bulk-AI
 * sweep populates the underlying content. Two real-world traps this
 * closes:
 *
 *   1. The merchant's footerLinks default has the FAQ row with
 *      `enabled: false` (hide-when-empty default — see
 *      `feedback-fwb-cms-and-tenant-control.md`). Once the sweep
 *      writes 8 FAQs, the link should obviously turn on; without
 *      this helper it stays hidden until the merchant manually
 *      toggles it in admin.
 *   2. /how-to-guides isn't in the default footerLinks shape at all
 *      (added 2026-05-13). For stores provisioned before then, the
 *      row simply doesn't exist — this appends it.
 *
 * The whole operation is a no-op when the link is already correctly
 * configured (enabled + present), so re-running the sweep doesn't
 * re-toggle anything. Safe to call on every sweep completion.
 */
async function ensureFooterSupportLinkEnabled(
  storeId: string,
  href: string,
  defaultName: string,
  defaultNameAr: string
): Promise<void> {
  try {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { settings: true },
    });
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
      // Patch in place: enable the entry, and backfill nameAr if missing
      // (older stores have entries without it — without nameAr the AR
      // storefront falls back to the English label).
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

    await prisma.store.update({
      where: { id: storeId },
      data: { settings: nextSettings },
    });

    logger.info(
      { storeId, href, defaultName },
      'bulk-ai-aeo: enabled footer support link after content sweep'
    );
  } catch (err) {
    // Never block the sweep result on a settings update — log + move on.
    // The sweep itself succeeded; the worst case here is the link stays
    // hidden until the merchant toggles it manually.
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

// -----------------------------------------------------------------------
// bulk-ai-faq-aeo — draft store-level FAQ items
// -----------------------------------------------------------------------

export const bulkAiFaqAeo: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-faq-aeo',
    name: 'Bulk: draft AEO FAQ items for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/faq-aeo-requested' }],
  },
  async ({ event }) => {
    const {
      jobId,
      storeId,
      count = 8,
    } = event.data as {
      jobId: string;
      storeId: string;
      count?: number;
    };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/faq-aeo-requested fired without ids');
      return;
    }

    const errors: Array<{
      entityKind: string;
      entityId: string;
      entityName: string;
      error: string;
    }> = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let quotaReached = false;

    try {
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date(), total: count },
      });

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
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
        });
        return;
      }

      // Fetch existing FAQs so we can smart-skip duplicates / locked entries.
      const existingFaqs = await prisma.storeFaq.findMany({
        where: { storeId },
        select: { question: true, manuallyEdited: true, orderIndex: true },
      });
      const lockedQuestions = new Set(
        existingFaqs.filter(f => f.manuallyEdited).map(f => f.question.trim().toLowerCase())
      );
      const maxOrder = existingFaqs.reduce((m, f) => Math.max(m, f.orderIndex), -1);

      // Build prompt
      const catNames = sampleCats.map(c => c.name).join(', ') || 'none';
      const prodNames =
        sampleProds
          .map(p => p.name)
          .join(', ')
          .slice(0, 500) || 'none';

      // Resolve the customer-facing payment methods this store actually
      // supports. The previous hardcoded "(KNET, Tap, MyFatoorah, cash on
      // delivery)" mixed customer methods with gateway company names and
      // produced answers like "We accept payment through Tap and
      // MyFatoorah" — meaningless to a shopper, since Tap / MyFatoorah
      // are the back-end processors, not what they tap on the checkout
      // page. Customers want method names: KNET, Visa, Mastercard, Apple
      // Pay, Cash on Delivery.
      //
      // PROVIDER_METHODS holds the per-gateway default method set for
      // Kuwait. Falls back to this when `paymentConfig.supportedMethods`
      // is empty (most stores leave it unset and rely on the gateway's
      // default).
      const PROVIDER_METHODS: Record<string, string[]> = {
        tap: ['KNET', 'Visa', 'Mastercard', 'Apple Pay'],
        myfatoorah: ['KNET', 'Visa', 'Mastercard', 'Apple Pay'],
        hesabe: ['KNET', 'Visa', 'Mastercard'],
        upayments: ['KNET', 'Visa', 'Mastercard'],
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

      const prompt = `You are an SEO + AEO expert helping a Kuwait-based e-commerce store author its FAQ page.

Store name: "${store.name}"${store.nameAr ? ` / "${store.nameAr}"` : ''}
Description: ${store.description ?? 'Not provided.'}
Sample categories: ${catNames}
Sample products: ${prodNames}

Draft exactly ${count} FAQs that real customers in Kuwait would ask. Cover:
- Delivery / shipping (Kuwait city, governorates, GCC)
- Payment methods. This store accepts EXACTLY: ${paymentMethodsList}. List those method names; do NOT name payment-gateway companies (Tap, MyFatoorah, Hesabe, UPayments) — customers tap KNET / Visa / Mastercard / Apple Pay buttons, they don't know which back-end gateway processes them.
- Returns and exchanges policy
- Product care / usage relevant to this store's category
- Store hours / how to contact support
- Bulk or wholesale orders (if relevant)
- Sizing or specs (if relevant)
- Loyalty programs or discount codes

Each FAQ: a clear, specific question + a concise 2-3 sentence answer. Both in English AND in Arabic (formal Modern Standard Arabic — not Egyptian or Levantine dialect).

Return ONLY a JSON array. Each element must have exactly these keys:
  question, questionAr, answer, answerAr
No other text, no markdown code fences — pure JSON only.`;

      await assertAiQuota();

      const genAI = getGenAI();
      const model = genAI.getGenerativeModel({
        model: MODEL,
        generationConfig: { responseMimeType: 'application/json' },
      });

      let drafted: DraftedFaq[] = [];
      try {
        const result = await callWithRetry(
          () => model.generateContent(prompt),
          `faq-aeo:${storeId}`
        );
        const raw = stripFences(result.response.text());
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array');
        drafted = parsed.slice(0, count);
      } catch (err) {
        if (isAiQuotaCapError(err)) throw err;
        const msg = err instanceof Error ? err.message : 'Gemini call failed';
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

      // Persist drafted FAQs (smart-skip locked questions)
      let orderCursor = maxOrder;
      for (const f of drafted) {
        // Validate required fields — Gemini occasionally drops a field
        if (!f.question?.trim() || !f.answer?.trim()) {
          skipped++;
          continue;
        }
        // Smart-skip: never overwrite a manually-edited entry
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
              error: err instanceof Error ? err.message : 'persist failed',
            });
          }
          failed++;
        }
      }
    } catch (err) {
      if (!isAiQuotaCapError(err)) throw err;
      quotaReached = true;
      if (errors.length < ERROR_CAP) {
        errors.push({
          entityKind: 'store',
          entityId: storeId,
          entityName: 'sweep',
          error: err instanceof Error ? err.message : 'AI quota cap reached',
        });
      }
    }

    await prisma.bulkAiJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        processed: filled + skipped + failed,
        filled,
        skipped,
        failed,
        errors: errors as object,
        completedAt: new Date(),
      },
    });

    // Surface the new content: enable /faq in the footer support column.
    // Only fires when this sweep actually wrote a row — re-running on an
    // already-populated store is a no-op via the smart-skip path.
    if (filled > 0) {
      await ensureFooterSupportLinkEnabled(storeId, '/faq', 'FAQ', 'الأسئلة الشائعة');
    }

    logger.info(
      { jobId, storeId, filled, skipped, failed, quotaReached },
      'bulk-ai-faq-aeo complete'
    );
  }
);

// -----------------------------------------------------------------------
// bulk-ai-howto-aeo — draft HowTo guides
// -----------------------------------------------------------------------

export const bulkAiHowtoAeo: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-howto-aeo',
    name: 'Bulk: draft AEO HowTo guides for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/howto-aeo-requested' }],
  },
  async ({ event }) => {
    const {
      jobId,
      storeId,
      count = 3,
    } = event.data as {
      jobId: string;
      storeId: string;
      count?: number;
    };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/howto-aeo-requested fired without ids');
      return;
    }

    const errors: Array<{
      entityKind: string;
      entityId: string;
      entityName: string;
      error: string;
    }> = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let quotaReached = false;

    try {
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date(), total: count },
      });

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
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
        });
        return;
      }

      // Smart-skip: don't re-draft a HowTo with the same title as an existing
      // manually-edited one.
      const existingHowtos = await prisma.storeHowto.findMany({
        where: { storeId },
        select: { title: true, manuallyEdited: true, orderIndex: true },
      });
      const lockedTitles = new Set(
        existingHowtos.filter(h => h.manuallyEdited).map(h => h.title.trim().toLowerCase())
      );
      const maxOrder = existingHowtos.reduce((m, h) => Math.max(m, h.orderIndex), -1);

      const catNames = sampleCats.map(c => c.name).join(', ') || 'none';
      const prodSample =
        sampleProds
          .slice(0, 8)
          .map(p => p.name)
          .join(', ') || 'none';

      const prompt = `You are an AEO (Answer Engine Optimisation) expert writing HowTo guides for a Kuwait-based e-commerce store.

Store name: "${store.name}"${store.nameAr ? ` / "${store.nameAr}"` : ''}
Categories: ${catNames}
Sample products: ${prodSample}

Write exactly ${count} HowTo guides that help customers understand this store's processes or products. Suggested topics (pick the most relevant for this store type):
- How to place an order
- How to choose the right size / variant
- How to return or exchange an item
- How to track your delivery in Kuwait
- How to care for [material/product type relevant to this store]
- How to use [a specific product or service]

For each guide:
- title: short, action-oriented (e.g. "How to Return an Item")
- titleAr: same in Arabic (formal MSA)
- description: 1-2 sentence overview
- descriptionAr: same in Arabic
- steps: 3-6 steps, each with "name" (short label) and "text" (1-2 sentence instruction)
- stepsAr: the same steps translated into Arabic

Return ONLY a JSON array. Each element must have exactly:
  title, titleAr, description, descriptionAr, steps, stepsAr
where steps and stepsAr are arrays of { name, text }.
No markdown, no code fences — pure JSON only.`;

      await assertAiQuota();

      const genAI = getGenAI();
      const model = genAI.getGenerativeModel({
        model: MODEL,
        generationConfig: { responseMimeType: 'application/json' },
      });

      let drafted: DraftedHowTo[] = [];
      try {
        const result = await callWithRetry(
          () => model.generateContent(prompt),
          `howto-aeo:${storeId}`
        );
        const raw = stripFences(result.response.text());
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('Gemini returned non-array');
        drafted = parsed.slice(0, count);
      } catch (err) {
        if (isAiQuotaCapError(err)) throw err;
        const msg = err instanceof Error ? err.message : 'Gemini call failed';
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
              error: err instanceof Error ? err.message : 'persist failed',
            });
          }
          failed++;
        }
      }
    } catch (err) {
      if (!isAiQuotaCapError(err)) throw err;
      quotaReached = true;
      if (errors.length < ERROR_CAP) {
        errors.push({
          entityKind: 'store',
          entityId: storeId,
          entityName: 'sweep',
          error: err instanceof Error ? err.message : 'AI quota cap reached',
        });
      }
    }

    await prisma.bulkAiJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        processed: filled + skipped + failed,
        filled,
        skipped,
        failed,
        errors: errors as object,
        completedAt: new Date(),
      },
    });

    // Surface the new content: ensure /how-to-guides is in the footer
    // support column AND enabled. For pre-2026-05-13 stores the entry
    // doesn't exist at all — the helper appends it. For newer stores
    // it just flips the existing entry's enabled flag.
    if (filled > 0) {
      await ensureFooterSupportLinkEnabled(
        storeId,
        '/how-to-guides',
        'How-To Guides',
        'أدلة الاستخدام'
      );
    }

    logger.info(
      { jobId, storeId, filled, skipped, failed, quotaReached },
      'bulk-ai-howto-aeo complete'
    );
  }
);

// -----------------------------------------------------------------------
// bulk-ai-meta-aeo — rewrite meta descriptions in conversational style
// -----------------------------------------------------------------------

/**
 * Rewrites metaDescription (store + products) to answer "What is X?"
 * style questions that answer engines like Perplexity or Google AI
 * Overview surface. Preserves the metaTitle and fills empty
 * metaDescriptionAr when the English rewrite was applied.
 *
 * Smart-skip rule:
 *   - Skip any product / store row where metaDescription starts with a
 *     value that looks like a manual edit. We detect this by checking
 *     whether the row's AiUsage history shows feature='meta_aeo' AND
 *     the meta fields have changed since. Instead of that complexity
 *     we simply re-run only rows where metaDescription is empty
 *     (missing entirely) OR where it was previously AI-drafted
 *     (no manual_meta flag exists yet — we use the presence of a
 *     non-empty metaDescription that doesn't look conversational as
 *     a signal to skip rather than stomp).
 *
 * Conservative default: only fill EMPTY metaDescription fields so
 * we never stomp on a merchant who has written a custom one. A
 * merchant who wants AEO rewrites on pre-existing meta can delete
 * and re-run, or use the per-entity SEO form.
 */
export const bulkAiMetaAeo: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-meta-aeo',
    name: 'Bulk: rewrite meta descriptions in conversational AEO style',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/meta-aeo-requested' }],
  },
  async ({ event }) => {
    const { jobId, storeId } = event.data as { jobId: string; storeId: string };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/meta-aeo-requested fired without ids');
      return;
    }

    const errors: Array<{
      entityKind: string;
      entityId: string;
      entityName: string;
      error: string;
    }> = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;
    let quotaReached = false;

    try {
      // Count to set total for progress bar — we now write to the AEO
      // columns specifically, so the "needs work" predicate is
      // `metaDescriptionAeo is null`, not `metaDescription is null`.
      const [productCount, categoryCount] = await Promise.all([
        prisma.product.count({ where: { storeId, deletedAt: null, metaDescriptionAeo: null } }),
        prisma.category.count({ where: { storeId, deletedAt: null, metaDescriptionAeo: null } }),
      ]);

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: 'running',
          startedAt: new Date(),
          total: productCount + categoryCount + 1, // +1 for the store row
        },
      });

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          nameAr: true,
          description: true,
          metaDescriptionAeo: true,
          metaDescriptionAeoAr: true,
        },
      });

      if (!store) {
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
        });
        return;
      }

      const genAI = getGenAI();

      // ---- Store-level meta ----
      // Writes to metaDescriptionAeo / metaDescriptionAeoAr (NOT the SEO
      // columns). Skip only if the dedicated AEO field is already
      // populated — so running the SEO sweep first no longer locks AEO
      // out of every row. Merchant clears the AEO column from admin if
      // they want a re-run.
      if (!store.metaDescriptionAeo?.trim()) {
        try {
          await assertAiQuota();

          const model = genAI.getGenerativeModel({
            model: MODEL,
            generationConfig: { responseMimeType: 'application/json' },
          });

          const prompt = buildMetaPrompt('store', store.name, store.description ?? '');
          const result = await callWithRetry(
            () => model.generateContent(prompt),
            `meta-aeo:store:${storeId}`
          );
          const raw = stripFences(result.response.text());
          const parsed = JSON.parse(raw) as { en: string; ar: string };

          if (typeof parsed.en === 'string' && parsed.en.trim()) {
            await prisma.store.update({
              where: { id: storeId },
              data: {
                metaDescriptionAeo: parsed.en.trim().slice(0, 160),
                metaDescriptionAeoAr:
                  parsed.ar?.trim().slice(0, 160) || store.metaDescriptionAeoAr || null,
              },
            });
            filled++;
          } else {
            skipped++;
          }
          await sleep(THROTTLE_MS);
        } catch (err) {
          if (isAiQuotaCapError(err)) throw err;
          const msg = err instanceof Error ? err.message : 'Gemini call failed';
          logger.error({ err, storeId, jobId }, 'bulk-ai-meta-aeo: store meta error');
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: store.name,
              error: msg,
            });
          failed++;
        }
      } else {
        skipped++;
      }
      processed++;

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { processed, filled, skipped, failed },
      });

      // ---- Products — page through ----
      const PAGE = 25;
      let cursor: string | null = null;
      while (true) {
        const products: Array<{
          id: string;
          name: string;
          nameAr: string | null;
          description: string | null;
          metaDescriptionAeo: string | null;
          metaDescriptionAeoAr: string | null;
        }> = await prisma.product.findMany({
          where: { storeId, deletedAt: null },
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: {
            id: true,
            name: true,
            nameAr: true,
            description: true,
            metaDescriptionAeo: true,
            metaDescriptionAeoAr: true,
          },
        });
        if (products.length === 0) break;

        for (const p of products) {
          // Smart-skip: only fill if AEO column is empty. SEO content
          // in metaDescription is irrelevant — AEO is a separate field.
          if (p.metaDescriptionAeo?.trim()) {
            skipped++;
            processed++;
            continue;
          }

          try {
            await assertAiQuota();

            const model = genAI.getGenerativeModel({
              model: MODEL,
              generationConfig: { responseMimeType: 'application/json' },
            });

            const prompt = buildMetaPrompt('product', p.name, p.description ?? '', store.name);
            const result = await callWithRetry(
              () => model.generateContent(prompt),
              `meta-aeo:product:${p.id}`
            );
            const raw = stripFences(result.response.text());
            const parsed = JSON.parse(raw) as { en: string; ar: string };

            if (typeof parsed.en === 'string' && parsed.en.trim()) {
              await prisma.product.update({
                where: { id: p.id },
                data: {
                  metaDescriptionAeo: parsed.en.trim().slice(0, 160),
                  metaDescriptionAeoAr:
                    parsed.ar?.trim().slice(0, 160) || p.metaDescriptionAeoAr || null,
                },
              });
              filled++;
            } else {
              skipped++;
            }
            await sleep(THROTTLE_MS);
          } catch (err) {
            if (isAiQuotaCapError(err)) throw err;
            const msg = err instanceof Error ? err.message : 'Gemini call failed';
            if (errors.length < ERROR_CAP)
              errors.push({
                entityKind: 'product',
                entityId: p.id,
                entityName: p.name,
                error: msg,
              });
            failed++;
          }
          processed++;
        }

        cursor = products[products.length - 1].id;

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { processed, filled, skipped, failed, errors: errors as object },
        });

        if (products.length < PAGE) break;
      }

      // ---- Categories — page through with same pattern as products ----
      let catCursor: string | null = null;
      while (true) {
        const cats: Array<{
          id: string;
          name: string;
          nameAr: string | null;
          description: string | null;
          metaDescriptionAeo: string | null;
          metaDescriptionAeoAr: string | null;
        }> = await prisma.category.findMany({
          where: { storeId, deletedAt: null },
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(catCursor ? { skip: 1, cursor: { id: catCursor } } : {}),
          select: {
            id: true,
            name: true,
            nameAr: true,
            description: true,
            metaDescriptionAeo: true,
            metaDescriptionAeoAr: true,
          },
        });
        if (cats.length === 0) break;

        for (const c of cats) {
          if (c.metaDescriptionAeo?.trim()) {
            skipped++;
            processed++;
            continue;
          }

          try {
            await assertAiQuota();

            const model = genAI.getGenerativeModel({
              model: MODEL,
              generationConfig: { responseMimeType: 'application/json' },
            });

            const prompt = buildMetaPrompt('category', c.name, c.description ?? '', store.name);
            const result = await callWithRetry(
              () => model.generateContent(prompt),
              `meta-aeo:category:${c.id}`
            );
            const raw = stripFences(result.response.text());
            const parsed = JSON.parse(raw) as { en: string; ar: string };

            if (typeof parsed.en === 'string' && parsed.en.trim()) {
              await prisma.category.update({
                where: { id: c.id },
                data: {
                  metaDescriptionAeo: parsed.en.trim().slice(0, 160),
                  metaDescriptionAeoAr:
                    parsed.ar?.trim().slice(0, 160) || c.metaDescriptionAeoAr || null,
                },
              });
              filled++;
            } else {
              skipped++;
            }
            await sleep(THROTTLE_MS);
          } catch (err) {
            if (isAiQuotaCapError(err)) throw err;
            const msg = err instanceof Error ? err.message : 'Gemini call failed';
            if (errors.length < ERROR_CAP)
              errors.push({
                entityKind: 'category',
                entityId: c.id,
                entityName: c.name,
                error: msg,
              });
            failed++;
          }
          processed++;
        }

        catCursor = cats[cats.length - 1].id;

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { processed, filled, skipped, failed, errors: errors as object },
        });

        if (cats.length < PAGE) break;
      }
    } catch (err) {
      if (!isAiQuotaCapError(err)) throw err;
      quotaReached = true;
      if (errors.length < ERROR_CAP) {
        errors.push({
          entityKind: 'store',
          entityId: storeId,
          entityName: 'sweep',
          error: err instanceof Error ? err.message : 'AI quota cap reached',
        });
      }
    }

    await prisma.bulkAiJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        processed,
        filled,
        skipped,
        failed,
        errors: errors as object,
        completedAt: new Date(),
      },
    });

    logger.info(
      { jobId, storeId, filled, skipped, failed, quotaReached },
      'bulk-ai-meta-aeo complete'
    );
  }
);

// -----------------------------------------------------------------------
// Prompt builder for conversational meta descriptions
// -----------------------------------------------------------------------

function buildMetaPrompt(
  kind: 'store' | 'product' | 'category',
  name: string,
  description: string,
  storeName?: string
): string {
  const context =
    kind === 'store'
      ? `Store name: "${name}"\nStore description: ${description || 'Not provided.'}`
      : kind === 'category'
        ? `Category: "${name}"\nFrom store: "${storeName ?? ''}"\nCategory description: ${description || 'Not provided.'}`
        : `Product: "${name}"\nFrom store: "${storeName ?? ''}"\nProduct description: ${description || 'Not provided.'}`;

  const naturalInclude =
    kind === 'store'
      ? 'the store name and its main product category'
      : kind === 'category'
        ? `the category name and the kinds of products it contains at ${storeName ?? 'the store'}`
        : 'the product name and what it does or is for';

  return `You are an AEO (Answer Engine Optimisation) expert writing meta descriptions for a Kuwait-based e-commerce ${kind}.

${context}

Write a meta description that directly answers the question a user might ask an AI assistant — like "What is ${name}?" or "What does ${storeName ?? name} sell?". Requirements:
- Conversational, first-answer style — like the opening sentence of a Wikipedia article
- Factual and specific, no marketing fluff or keyword stuffing
- Between 130-160 characters (English)
- Naturally include ${naturalInclude}
- Both English and Arabic (formal MSA)

Return ONLY a JSON object with keys "en" and "ar". No markdown, no code fences — pure JSON only.
Example: {"en": "Force Store is a Kuwait-based online retailer ...", "ar": "فورس ستور متجر كويتي متخصص في ..."}`;
}
