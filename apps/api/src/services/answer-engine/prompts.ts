/**
 * Buyer-intent prompt generation for the answer-engine citation scan
 * (AEO/GEO insights feature, Task 6).
 *
 * Builds a small, deterministic set of shopper-style prompts from a store's
 * own catalogue data — its top active categories and best-selling/most-
 * viewed active products — in both English and Arabic, so each weekly scan
 * asks the same kind of question a real shopper would type into ChatGPT/
 * Perplexity/Google AI Overviews.
 *
 * v1 is AUTO-ONLY. `Store` has no merchant-authored "answer-engine override
 * prompt" field today — adding one is a schema change out of scope for this
 * task (see task-6-brief.md). FOLLOW-UP: once such a field exists (e.g. a
 * `answerEnginePrompts: string[]` column or a dedicated table), merge it
 * in here (auto-generated + merchant overrides, de-duplicated) rather than
 * replacing the auto set.
 *
 * Kept intentionally small (a handful of prompts per store) — this function
 * runs once per store per scan, multiplied by every enabled engine, so its
 * output size directly drives AI spend.
 */
import { storeDb } from '../../lib/repo-factory';

import { REGION } from '@ebda/shared';
import { visibleProductWhere } from '../../lib/visible-product';
export interface GeneratedPrompt {
  text: string;
  locale: 'en' | 'ar';
}

// Every store on this platform sells into the Egypt market today — see
// CLAUDE.md's "Arabic-first locality" pillar. Not store-configurable yet
// (no `country` field on Store); revisit if/when multi-country expansion
// lands.
const COUNTRY_EN = REGION.countryName.en;
const COUNTRY_AR = REGION.countryName.ar;

// Caps that keep the prompt set small — see file header. 2 categories + 2
// products, EN+AR each, yields at most 8 prompts per store per scan.
const MAX_CATEGORIES = 2;
const MAX_PRODUCTS = 2;

/**
 * Generates the buyer-intent prompt set for a single store. Pure-ish (reads
 * store data via Prisma, no writes) — safe to call repeatedly and easy to
 * unit test against a seeded store/category/product fixture.
 */
export async function generatePrompts(storeId: string): Promise<GeneratedPrompt[]> {
  const db = await storeDb(storeId);
  const [categories, products] = await Promise.all([
    db.category.findMany({
      where: { storeId, deletedAt: null, isActive: true },
      orderBy: { position: 'asc' },
      select: { name: true, nameAr: true },
      take: MAX_CATEGORIES,
    }),
    // A wholesale-only product's NAME must never reach a third-party answer engine (Ruling B2B-7; final review minor 1).
    db.product.findMany({
      where: { storeId, deletedAt: null, status: 'active', ...visibleProductWhere() },
      orderBy: [{ isBestSeller: 'desc' }, { viewCount: 'desc' }],
      select: { name: true, nameAr: true },
      take: MAX_PRODUCTS,
    }),
  ]);

  const prompts: GeneratedPrompt[] = [];

  for (const category of categories) {
    prompts.push({ text: `best ${category.name} in ${COUNTRY_EN}`, locale: 'en' });
    prompts.push({
      text: `أفضل ${category.nameAr ?? category.name} في ${COUNTRY_AR}`,
      locale: 'ar',
    });
  }

  for (const product of products) {
    prompts.push({ text: `where to buy ${product.name} in ${COUNTRY_EN}`, locale: 'en' });
    prompts.push({
      text: `أين أشتري ${product.nameAr ?? product.name} في ${COUNTRY_AR}`,
      locale: 'ar',
    });
  }

  // AUTO-ONLY for v1 — see file header for the merchant-override follow-up.

  return prompts;
}
