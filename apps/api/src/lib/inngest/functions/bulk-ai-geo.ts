import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { sanitizeJsonControlChars } from '../../ai/parse-ai-json';

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

  // Extract the outermost JSON span. Gemini occasionally appends explanatory
  // text after a valid JSON body even when prompted for pure JSON. Slice
  // from the first `{` or `[` to the last `}` or `]`. See bulk-ai-aeo.ts
  // for full rationale (2026-05-25 fix after Mastic + caraway products
  // failed AEO meta sweep with "Unexpected non-whitespace character after
  // JSON at position 331").
  const firstOpen = s.search(/[\{\[]/);
  if (firstOpen > 0) s = s.slice(firstOpen);

  const lastClose = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastClose !== -1 && lastClose < s.length - 1) {
    s = s.slice(0, lastClose + 1);
  }

  return s;
}

// -----------------------------------------------------------------------
// bulk-ai-llms-txt — generate /llms.txt content for the store
// -----------------------------------------------------------------------

export const bulkAiLlmsTxt: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-llms-txt',
    name: 'Bulk: generate LLMs.txt content for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/llms-txt-requested' }],
  },
  async ({ event }) => {
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

    return runInTenantContext(storeId, async () => {
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
          data: { status: 'running', startedAt: new Date(), total: 1 },
        });

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
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
          return;
        }

        // Smart-skip: only regenerate if llmsTxt is empty. When force=true, bypass.
        if (!force && store.llmsTxt?.trim()) {
          skipped++;
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              processed: 1,
              filled: 0,
              skipped: 1,
              failed: 0,
              completedAt: new Date(),
            },
          });
          logger.info({ jobId, storeId }, 'bulk-ai-llms-txt: skipped (already populated)');
          return;
        }

        const storeUrl = store.domain
          ? `https://${store.domain}`
          : `https://store.forcemediakw.com/${store.slug}`;

        const catList = categories
          .map(
            c => `- ${c.name}${c.nameAr ? ` / ${c.nameAr}` : ''}: ${storeUrl}/categories/${c.slug}`
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
          const result = await callWithRetry(
            () => model.generateContent(prompt),
            `llms-txt:${storeId}`
          );
          const text = result.response.text().trim();

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
          const msg = err instanceof Error ? err.message : 'Gemini call failed';
          logger.error({ err, storeId, jobId }, 'bulk-ai-llms-txt: Gemini error');
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: store.name,
              error: msg,
            });
          failed++;
        }
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        quotaReached = true;
        if (errors.length < ERROR_CAP)
          errors.push({
            entityKind: 'store',
            entityId: storeId,
            entityName: 'sweep',
            error: err instanceof Error ? err.message : 'AI quota cap reached',
          });
      }

      // Only mark completed if the merchant didn't cancel.
      const llmsFinalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: llmsFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          processed: filled + skipped + failed,
          filled,
          skipped,
          failed,
          errors: errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-llms-txt complete'
      );
    }); // end runInTenantContext
  }
);

// -----------------------------------------------------------------------
// bulk-ai-citation-copy — rewrite product descriptions for LLM citation
// -----------------------------------------------------------------------

export const bulkAiCitationCopy: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-citation-copy',
    name: 'Bulk: generate LLM citation copy for products',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/citation-copy-requested' }],
  },
  async ({ event }) => {
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

    return runInTenantContext(storeId, async () => {
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
        const productCount = await prisma.product.count({
          where: { storeId, deletedAt: null, citationCopy: null },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'running', startedAt: new Date(), total: productCount },
        });

        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true, nameAr: true },
        });

        if (!store) {
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
          return;
        }

        const genAI = getGenAI();
        const PAGE = 25;
        let cursor: string | null = null;

        while (true) {
          const products: Array<{
            id: string;
            name: string;
            nameAr: string | null;
            description: string | null;
            citationCopy: string | null;
            citationCopyAr: string | null;
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
              citationCopy: true,
              citationCopyAr: true,
            },
          });
          if (products.length === 0) break;

          for (const p of products) {
            // Cooperative cancellation — check every 5 products.
            if (processed % 5 === 0 && processed > 0) {
              const currentJob = await prisma.bulkAiJob.findUnique({
                where: { id: jobId },
                select: { status: true },
              });
              if (currentJob?.status === 'cancelled') {
                logger.info(
                  { jobId, storeId, processed, filled, skipped, failed },
                  'bulk-ai-citation-copy: cancelled by merchant'
                );
                break;
              }
            }

            // Smart-skip: only fill if citation copy is empty.
            // When force=true, process even if already populated.
            if (!force && p.citationCopy?.trim()) {
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

              const prompt = `You are an expert at writing product descriptions optimised for LLM citation — the definitive, factual sentence an AI assistant would quote when answering "What is ${
                p.name
              }?".

Product: "${p.name}"${p.nameAr ? ` / "${p.nameAr}"` : ''}
From store: "${store.name}"
Description: ${p.description || 'Not provided.'}

Write a citation-optimised product description:
1. First sentence: definitional ("${p.name} is a...") — 1 clear factual sentence
2. Key specs/attributes block: 2-4 bullet points of the most citable facts

Return ONLY a JSON object with keys "en" and "ar". Both fields are plain text (no markdown). Under 300 chars each.
Example: {"en": "Product X is a...\n• Spec 1\n• Spec 2", "ar": "المنتج X هو...\n• المعيار 1"}`;

              const result = await callWithRetry(
                () => model.generateContent(prompt),
                `citation-copy:product:${p.id}`
              );
              const raw = sanitizeJsonControlChars(stripFences(result.response.text()));
              const parsed = JSON.parse(raw) as { en: string; ar: string };

              if (typeof parsed.en === 'string' && parsed.en.trim()) {
                await prisma.product.update({
                  where: { id: p.id },
                  data: {
                    citationCopy: parsed.en.trim().slice(0, 500),
                    citationCopyAr: parsed.ar?.trim().slice(0, 500) || p.citationCopyAr || null,
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
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        quotaReached = true;
        if (errors.length < ERROR_CAP)
          errors.push({
            entityKind: 'store',
            entityId: storeId,
            entityName: 'sweep',
            error: err instanceof Error ? err.message : 'AI quota cap reached',
          });
      }

      // Only mark completed if the merchant didn't cancel.
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
    }); // end runInTenantContext
  }
);

// -----------------------------------------------------------------------
// bulk-ai-brand-facts — generate Store.aboutJson for Organization JSON-LD
// -----------------------------------------------------------------------

export const bulkAiBrandFacts: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-brand-facts',
    name: 'Bulk: generate brand facts JSON for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/brand-facts-requested' }],
  },
  async ({ event }) => {
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

    return runInTenantContext(storeId, async () => {
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
          data: { status: 'running', startedAt: new Date(), total: 1 },
        });

        const [store, sampleCats, contactInfo] = await Promise.all([
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
          prisma.store.findUnique({
            where: { id: storeId },
            select: { socialLinks: true, settings: true },
          }),
        ]);

        if (!store) {
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
          return;
        }

        // Smart-skip: only fill if aboutJson is empty. When force=true, bypass.
        if (!force && store.aboutJson) {
          skipped++;
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              processed: 1,
              filled: 0,
              skipped: 1,
              failed: 0,
              completedAt: new Date(),
            },
          });
          logger.info({ jobId, storeId }, 'bulk-ai-brand-facts: skipped (already populated)');
          return;
        }

        const catNames = sampleCats.map(c => c.name).join(', ') || 'none';
        const langs = store.nameAr ? 'Arabic and English' : 'English';
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
          const result = await callWithRetry(
            () => model.generateContent(prompt),
            `brand-facts:${storeId}`
          );
          const raw = sanitizeJsonControlChars(stripFences(result.response.text()));
          const parsed = JSON.parse(raw);

          if (parsed && typeof parsed === 'object') {
            await prisma.store.update({
              where: { id: storeId },
              data: { aboutJson: parsed },
            });
            filled++;
          } else {
            skipped++;
          }
          await sleep(THROTTLE_MS);
        } catch (err) {
          if (isAiQuotaCapError(err)) throw err;
          const msg = err instanceof Error ? err.message : 'Gemini call failed';
          logger.error({ err, storeId, jobId }, 'bulk-ai-brand-facts: Gemini error');
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: store.name,
              error: msg,
            });
          failed++;
        }
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        quotaReached = true;
        if (errors.length < ERROR_CAP)
          errors.push({
            entityKind: 'store',
            entityId: storeId,
            entityName: 'sweep',
            error: err instanceof Error ? err.message : 'AI quota cap reached',
          });
      }

      // Only mark completed if the merchant didn't cancel.
      const factsFinalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: factsFinalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          processed: filled + skipped + failed,
          filled,
          skipped,
          failed,
          errors: errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-brand-facts complete'
      );
    }); // end runInTenantContext
  }
);
