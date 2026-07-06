import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { GoogleGenerativeAI } from '@google/generative-ai';
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

const AI_UNAVAILABLE_MESSAGE = 'AI request failed — please try again shortly.';

/**
 * GEO (Generative Engine Optimization) bulk sweeps — generates content
 * that improves a store's visibility in LLM-powered search (ChatGPT,
 * Perplexity, Google AI Overview, Bing Copilot citations).
 *
 * Three Inngest functions registered here:
 *   bulk-ai-llms-txt        — generates /llms.txt content for the store
 *   bulk-ai-citation-copy   — rewrites product descriptions for LLM citation
 *   bulk-ai-brand-facts     — generates Store.aboutJson (Organization JSON-LD data)
 *
 * All three follow the same patterns as bulk-ai-aeo:
 *   - Throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - Abort on AI_DAILY_REQUEST_CAP / AI_MONTHLY_REQUEST_CAP
 *   - Cap error list at 50 per run
 *   - Mark BulkAiJob completed regardless
 *
 * PR2 — crash-resumable steps. `bulk-ai-llms-txt` / `bulk-ai-brand-facts`
 * each make a SINGLE Gemini call for the whole store — nothing to batch, so
 * the whole fetch+generate+persist body is wrapped in one
 * `step.run('generate-and-persist', ...)`. `bulk-ai-citation-copy` DOES loop
 * over every product, so it gets full batching: `step.run('load-items', ...)`
 * loads a stable product-id list, split into `BULK_AI_BATCH_SIZE`-sized
 * batches, each processed inside its own `step.run(\`batch-${i}\`, ...)` — a
 * crash mid-sweep resumes at the first unfinished batch, and each item's
 * current citation copy is re-read fresh at batch time (idempotency
 * re-check).
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

function stripFences(text: string): string {
  let s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const firstOpen = s.search(/[\{\[]/);
  if (firstOpen > 0) s = s.slice(firstOpen);

  const lastClose = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastClose !== -1 && lastClose < s.length - 1) {
    s = s.slice(0, lastClose + 1);
  }

  return s;
}

interface GeoErr {
  entityKind: string;
  entityId: string;
  entityName: string;
  error: string;
}

// -----------------------------------------------------------------------
// bulk-ai-llms-txt — generate /llms.txt content for the store
// -----------------------------------------------------------------------

// NOTE: inferred WITHOUT the `InngestFunction.Any` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const bulkAiLlmsTxtFn = inngest.createFunction(
  {
    id: 'bulk-ai-llms-txt',
    name: 'Bulk: generate LLMs.txt content for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/llms-txt-requested' }],
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
      logger.warn('bulk-ai/llms-txt-requested fired without ids');
      return;
    }

    return (async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'running', startedAt: new Date(), total: 1, force },
        })
      );

      let result: {
        notFound: boolean;
        filled: number;
        skipped: number;
        failed: number;
        errors: GeoErr[];
        quotaReached?: boolean;
      };
      try {
        result = await step.run('generate-and-persist', async () => {
          const errors: GeoErr[] = [];
          let filled = 0;
          let skipped = 0;
          let failed = 0;

          const [store, categories, sampleProducts] = await Promise.all([
            prisma.store.findUnique({
              where: { id: storeId },
              select: {
                name: true,
                nameAr: true,
                description: true,
                slug: true,
                domain: true,
                llmsTxt: true,
              },
            }),
            prisma.category.findMany({
              where: { storeId, isActive: true },
              select: { name: true, nameAr: true, slug: true },
              orderBy: { position: 'asc' },
              take: 20,
            }),
            prisma.product.findMany({
              where: { storeId, status: 'active', deletedAt: null },
              select: { name: true, nameAr: true, slug: true, price: true },
              take: 10,
            }),
          ]);

          if (!store) {
            return { notFound: true, filled, skipped, failed, errors };
          }

          if (!force && store.llmsTxt?.trim()) {
            skipped++;
            return { notFound: false, filled, skipped, failed, errors };
          }

          const storeUrl = store.domain
            ? `https://${store.domain}`
            : `https://store.force-ai.co/${store.slug}`;

          const catList = categories
            .map(
              c =>
                `- ${c.name}${c.nameAr ? ` / ${c.nameAr}` : ''}: ${storeUrl}/categories/${c.slug}`
            )
            .join('\n');

          const prodList = sampleProducts
            .slice(0, 10)
            .map(p => `- ${p.name}: ${storeUrl}/products/${p.slug}`)
            .join('\n');

          const prompt = `You are generating an llms.txt file for an e-commerce store. llms.txt is a standard file that helps AI language models understand and index a website's content.

Store name: "${store.name}"${store.nameAr ? ` / "${store.nameAr}"` : ''}
Store URL: ${storeUrl}
Description: ${store.description || 'Kuwait-based online store.'}

Categories (${categories.length} total):
${catList || '(none yet)'}

Sample products:
${prodList || '(none yet)'}

Generate a concise llms.txt file with the following sections:
1. A # heading with the store name
2. A brief > blockquote description (1-2 sentences, plain text)
3. ## Store pages section listing key pages
4. ## Product categories section listing all categories with URLs
5. ## Notes section with any AI-relevant context (language support, currency, region)

Use the exact URL format shown above. Keep the output under 2000 characters. Return ONLY the raw markdown text — no code fences, no extra commentary.`;

          try {
            await assertAiQuota();

            const genAI = getGenAI();
            const model = genAI.getGenerativeModel({ model: MODEL });
            const genResult = await callWithRetry(
              () => model.generateContent(prompt),
              `llms-txt:${storeId}`
            ).catch((err: unknown) => rethrowAsAppError(err, 'AI llms.txt sweep failed'));
            const usage = genResult.response.usageMetadata;
            await recordUsage(
              storeId,
              'geo',
              usage?.promptTokenCount ?? 0,
              usage?.candidatesTokenCount ?? 0,
              false
            );
            const text = genResult.response.text().trim();

            if (text.length > 50) {
              await prisma.store.update({
                where: { id: storeId },
                data: { llmsTxt: text.slice(0, 4000) },
              });
              filled++;
            } else {
              skipped++;
            }
            await sleep(THROTTLE_MS);
          } catch (err) {
            if (isAiQuotaCapError(err)) throw err;
            const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
            logger.error({ err, storeId, jobId }, 'bulk-ai-llms-txt: Gemini error');
            if (errors.length < ERROR_CAP) {
              errors.push({
                entityKind: 'store',
                entityId: storeId,
                entityName: store.name,
                error: msg,
              });
            }
            failed++;
          }

          return { notFound: false, filled, skipped, failed, errors };
        });
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        result = {
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

      if (result.notFound) {
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
        });
        return;
      }

      const quotaReached = result.quotaReached === true;

      const llmsFinalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: llmsFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          processed: result.filled + result.skipped + result.failed,
          filled: result.filled,
          skipped: result.skipped,
          failed: result.failed,
          errors: result.errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        {
          jobId,
          storeId,
          filled: result.filled,
          skipped: result.skipped,
          failed: result.failed,
          quotaReached,
          force,
        },
        'bulk-ai-llms-txt complete'
      );
    })(); // end runInTenantContext
  }
);
export const bulkAiLlmsTxt: InngestFunction.Any = bulkAiLlmsTxtFn;

// -----------------------------------------------------------------------
// bulk-ai-citation-copy — rewrite product descriptions for LLM citation
// -----------------------------------------------------------------------

interface CitationBatchResult {
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errors: GeoErr[];
  quotaReached: boolean;
  cancelled: boolean;
}

// NOTE: see the comment on bulkAiLlmsTxtFn above — same contextual-typing trap.
const bulkAiCitationCopyFn = inngest.createFunction(
  {
    id: 'bulk-ai-citation-copy',
    name: 'Bulk: generate LLM citation copy for products',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/citation-copy-requested' }],
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
      logger.warn('bulk-ai/citation-copy-requested fired without ids');
      return;
    }

    return (async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'running', startedAt: new Date(), force },
        })
      );

      const { storeFound, productIds } = await step.run('load-items', async () => {
        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { id: true },
        });
        if (!store) return { storeFound: false, productIds: [] as string[] };
        const products = await prisma.product.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });
        await prisma.bulkAiJob.update({ where: { id: jobId }, data: { total: products.length } });
        return { storeFound: true, productIds: products.map(p => p.id) };
      });

      if (!storeFound) {
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
        });
        return;
      }

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { name: true, nameAr: true },
      });
      const storeName = store?.name ?? storeId;

      const batches = chunk(productIds, BULK_AI_BATCH_SIZE);

      const errors: GeoErr[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];

        const result: CitationBatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await prisma.bulkAiJob.findUnique({
            where: { id: jobId },
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

          const items = await prisma.product.findMany({
            where: { id: { in: batchIds } },
            select: {
              id: true,
              name: true,
              nameAr: true,
              description: true,
              citationCopy: true,
              citationCopyAr: true,
            },
          });
          const byId = new Map(items.map(p => [p.id, p]));

          let bProcessed = 0;
          let bFilled = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: GeoErr[] = [];

          for (const id of batchIds) {
            const p = byId.get(id);
            if (!p) {
              bSkipped++;
              bProcessed++;
              continue;
            }
            if (!force && p.citationCopy?.trim()) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              await assertAiQuota();

              const prompt = `You are an expert at writing product descriptions optimised for LLM citation — the definitive, factual sentence an AI assistant would quote when answering "What is ${p.name}?".

Product: "${p.name}"${p.nameAr ? ` / "${p.nameAr}"` : ''}
From store: "${storeName}"
Description: ${p.description || 'Not provided.'}

Write a citation-optimised product description:
1. First sentence: definitional ("${p.name} is a...") — 1 clear factual sentence
2. Key specs/attributes block: 2-4 bullet points of the most citable facts

Return ONLY a JSON object with keys "en" and "ar". Both fields are plain text (no markdown). Under 300 chars each.
Example: {"en": "Product X is a...\n• Spec 1\n• Spec 2", "ar": "المنتج X هو...\n• المعيار 1"}`;

              const genResult = await callWithRetry(
                () => model.generateContent(prompt),
                `citation-copy:product:${p.id}`
              ).catch((err: unknown) => rethrowAsAppError(err, 'AI citation-copy sweep failed'));
              const usage = genResult.response.usageMetadata;
              await recordUsage(
                storeId,
                'geo',
                usage?.promptTokenCount ?? 0,
                usage?.candidatesTokenCount ?? 0,
                false
              );
              const raw = sanitizeJsonControlChars(stripFences(genResult.response.text()));
              const parsed = JSON.parse(raw) as { en: string; ar: string };

              if (typeof parsed.en === 'string' && parsed.en.trim()) {
                await prisma.product.update({
                  where: { id: p.id },
                  data: {
                    citationCopy: parsed.en.trim().slice(0, 500),
                    citationCopyAr: parsed.ar?.trim().slice(0, 500) || p.citationCopyAr || null,
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
            where: { id: jobId },
            data: { processed, filled, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, filled, skipped, failed },
            'bulk-ai-citation-copy: cancelled by merchant'
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

      const citationFinalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: citationFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          processed,
          filled,
          skipped,
          failed,
          errors: errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-citation-copy complete'
      );
    })(); // end runInTenantContext
  }
);
export const bulkAiCitationCopy: InngestFunction.Any = bulkAiCitationCopyFn;

// -----------------------------------------------------------------------
// bulk-ai-brand-facts — generate Store.aboutJson for Organization JSON-LD
// -----------------------------------------------------------------------

// NOTE: see the comment on bulkAiLlmsTxtFn above — same contextual-typing trap.
const bulkAiBrandFactsFn = inngest.createFunction(
  {
    id: 'bulk-ai-brand-facts',
    name: 'Bulk: generate brand facts JSON for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/brand-facts-requested' }],
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
      logger.warn('bulk-ai/brand-facts-requested fired without ids');
      return;
    }

    return (async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'running', startedAt: new Date(), total: 1, force },
        })
      );

      let result: {
        notFound: boolean;
        filled: number;
        skipped: number;
        failed: number;
        errors: GeoErr[];
        quotaReached?: boolean;
      };
      try {
        result = await step.run('generate-and-persist', async () => {
          const errors: GeoErr[] = [];
          let filled = 0;
          let skipped = 0;
          let failed = 0;

          const [store, sampleCats] = await Promise.all([
            prisma.store.findUnique({
              where: { id: storeId },
              select: {
                name: true,
                nameAr: true,
                description: true,
                email: true,
                phone: true,
                address: true,
                aboutJson: true,
              },
            }),
            prisma.category.findMany({
              where: { storeId, isActive: true },
              select: { name: true },
              orderBy: { position: 'asc' },
              take: 10,
            }),
          ]);

          if (!store) {
            return { notFound: true, filled, skipped, failed, errors };
          }

          if (!force && store.aboutJson) {
            skipped++;
            return { notFound: false, filled, skipped, failed, errors };
          }

          const catNames = sampleCats.map(c => c.name).join(', ') || 'none';
          const contactMethods =
            [store.email ? `email: ${store.email}` : '', store.phone ? `phone: ${store.phone}` : '']
              .filter(Boolean)
              .join(', ') || 'not specified';

          const prompt = `You are generating structured brand facts JSON for a Kuwait-based e-commerce store. This will be used for Schema.org Organization JSON-LD to improve LLM citations.

Store: "${store.name}"${store.nameAr ? ` / "${store.nameAr}"` : ''}
Description: ${store.description || 'Kuwait-based online store.'}
Categories: ${catNames}
Contact: ${contactMethods}
Location: Kuwait

Generate a JSON object with the following structure:
{
  "location": "Kuwait",
  "keyCategories": ["category1", "category2", ...],
  "languages": ["Arabic", "English"],
  "contactMethods": ["email", "whatsapp"],
  "region": "GCC",
  "currency": "KWD"
}

Populate using only the information provided above. For keyCategories, use the category names. For contactMethods, only include what was explicitly stated. Keep it concise. Return ONLY the raw JSON object — no markdown, no code fences.`;

          try {
            await assertAiQuota();

            const genAI = getGenAI();
            const model = genAI.getGenerativeModel({
              model: MODEL,
              generationConfig: { responseMimeType: 'application/json' },
            });
            const genResult = await callWithRetry(
              () => model.generateContent(prompt),
              `brand-facts:${storeId}`
            ).catch((err: unknown) => rethrowAsAppError(err, 'AI brand-facts sweep failed'));
            const usage = genResult.response.usageMetadata;
            await recordUsage(
              storeId,
              'geo',
              usage?.promptTokenCount ?? 0,
              usage?.candidatesTokenCount ?? 0,
              false
            );
            const raw = sanitizeJsonControlChars(stripFences(genResult.response.text()));
            const parsed = JSON.parse(raw);

            if (parsed && typeof parsed === 'object') {
              await prisma.store.update({ where: { id: storeId }, data: { aboutJson: parsed } });
              filled++;
            } else {
              skipped++;
            }
            await sleep(THROTTLE_MS);
          } catch (err) {
            if (isAiQuotaCapError(err)) throw err;
            const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
            logger.error({ err, storeId, jobId }, 'bulk-ai-brand-facts: Gemini error');
            if (errors.length < ERROR_CAP) {
              errors.push({
                entityKind: 'store',
                entityId: storeId,
                entityName: store.name,
                error: msg,
              });
            }
            failed++;
          }

          return { notFound: false, filled, skipped, failed, errors };
        });
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        result = {
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

      if (result.notFound) {
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
        });
        return;
      }

      const quotaReached = result.quotaReached === true;

      const factsFinalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: factsFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          processed: result.filled + result.skipped + result.failed,
          filled: result.filled,
          skipped: result.skipped,
          failed: result.failed,
          errors: result.errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        {
          jobId,
          storeId,
          filled: result.filled,
          skipped: result.skipped,
          failed: result.failed,
          quotaReached,
          force,
        },
        'bulk-ai-brand-facts complete'
      );
    })(); // end runInTenantContext
  }
);
export const bulkAiBrandFacts: InngestFunction.Any = bulkAiBrandFactsFn;
