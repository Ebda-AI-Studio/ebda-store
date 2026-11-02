/**
 * Plan "Bug 10: placeholder copy gets published" — every bulk AI sweep
 * (store FAQ, store HowTo, meta-AEO x3, llms.txt, citation-copy, product
 * FAQ) writes Gemini's output DIRECTLY to a live, store-facing
 * column/table and busts the public cache in the same step. There is no
 * merchant draft/review gate on this path (unlike the single-item "Draft
 * with AI" routes, which return the suggestion to the admin UI for the
 * merchant to accept or edit first).
 *
 * Before this fix, the only check guarding every one of those writes was
 * "non-empty after .trim()" — a degenerate Gemini response like "N/A",
 * "TBD", "..." or "[insert text here]" trivially satisfies that and would
 * have gone live on the storefront with zero human review. `isPlaceholder`
 * (`lib/ai/eval/helpers.ts`, re-exporting `lib/ai/placeholder-guard.ts`)
 * already existed and already recognizes exactly this content — but it was
 * wired into the OFFLINE AI-output eval harness only
 * (`lib/ai/eval/criteria.ts`), never into any live write path.
 *
 * Driving these Inngest functions end-to-end needs a full Gemini + Prisma +
 * Inngest-step mock rig; this asserts on the SOURCE instead (the same
 * approach `bulk-ai-store-cache-bust.test.ts` uses here for the same
 * reason), scoped per function by its declared Inngest `id` so it survives
 * line-number drift.
 *
 * Mutation-proof: removing the `isPlaceholderText(...)` guard from any one
 * write site below reddens that site's assertion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlaceholderText } from '../../apps/api/src/lib/ai/placeholder-guard';

const AEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts');
const GEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-geo.ts');
const PRODUCT_FAQS_PATH = join(
  __dirname,
  '../../apps/api/src/lib/inngest/functions/bulk-ai-product-faqs.ts'
);

/** The body of the Inngest function declared with `id: '<functionId>'`, up to the next such declaration (or EOF). */
function functionBody(source: string, functionId: string): string {
  const marker = `id: '${functionId}'`;
  const start = source.indexOf(marker);
  expect(start, `could not find ${marker}`).toBeGreaterThanOrEqual(0);
  const nextMarker = source.indexOf("id: '", start + marker.length);
  return nextMarker === -1 ? source.slice(start) : source.slice(start, nextMarker);
}

describe('isPlaceholderText (shared guard)', () => {
  it('flags degenerate Gemini output a bulk sweep must not publish', () => {
    expect(isPlaceholderText('N/A')).toBe(true);
    expect(isPlaceholderText('TBD')).toBe(true);
    expect(isPlaceholderText('...')).toBe(true);
    expect(isPlaceholderText('[insert text here]')).toBe(true);
    expect(isPlaceholderText('')).toBe(true);
    expect(isPlaceholderText('   ')).toBe(true);
  });

  it('passes genuine generated content', () => {
    expect(isPlaceholderText('Delivery takes 2-4 business days across Cairo and Giza.')).toBe(
      false
    );
  });
});

describe('bulk-ai-aeo.ts: every live write site rejects placeholder output before it reaches the store', () => {
  const source = readFileSync(AEO_PATH, 'utf8');

  it('imports the shared guard', () => {
    expect(source).toContain("from '../../ai/placeholder-guard'");
  });

  it('bulk-ai-faq-aeo guards StoreFaq.create (question + answer)', () => {
    const body = functionBody(source, 'bulk-ai-faq-aeo');
    const createIdx = body.indexOf('sw.storeFaq.create');
    expect(createIdx).toBeGreaterThan(-1);
    const guardIdx = body.lastIndexOf('isPlaceholderText', createIdx);
    expect(guardIdx, 'no isPlaceholderText guard before storeFaq.create').toBeGreaterThan(-1);
  });

  it('bulk-ai-howto-aeo guards StoreHowto.create (title + description)', () => {
    const body = functionBody(source, 'bulk-ai-howto-aeo');
    const createIdx = body.indexOf('sw.storeHowto.create');
    expect(createIdx).toBeGreaterThan(-1);
    const guardIdx = body.lastIndexOf('isPlaceholderText', createIdx);
    expect(guardIdx, 'no isPlaceholderText guard before storeHowto.create').toBeGreaterThan(-1);
  });

  it('bulk-ai-meta-aeo guards the store/product/category metaDescriptionAeo writes', () => {
    const body = functionBody(source, 'bulk-ai-meta-aeo');
    const guardCount = body.split('isPlaceholderText').length - 1;
    // Three write sites (store, product, category) each need their own guard.
    expect(guardCount, 'expected a guard at each of the 3 metaDescriptionAeo writes').toBe(3);
  });
});

describe('bulk-ai-geo.ts: every live write site rejects placeholder output before it reaches the store', () => {
  const source = readFileSync(GEO_PATH, 'utf8');

  it('imports the shared guard', () => {
    expect(source).toContain("from '../../ai/placeholder-guard'");
  });

  it('bulk-ai-llms-txt guards Store.llmsTxt', () => {
    const body = functionBody(source, 'bulk-ai-llms-txt');
    const updateIdx = body.indexOf('data: { llmsTxt:');
    expect(updateIdx).toBeGreaterThan(-1);
    const guardIdx = body.lastIndexOf('isPlaceholderText', updateIdx);
    expect(guardIdx, 'no isPlaceholderText guard before Store.llmsTxt write').toBeGreaterThan(-1);
  });

  it('bulk-ai-citation-copy guards Product.citationCopy', () => {
    const body = functionBody(source, 'bulk-ai-citation-copy');
    const updateIdx = body.indexOf('citationCopy: parsed.en');
    expect(updateIdx).toBeGreaterThan(-1);
    const guardIdx = body.lastIndexOf('isPlaceholderText', updateIdx);
    expect(
      guardIdx,
      'no isPlaceholderText guard before Product.citationCopy write'
    ).toBeGreaterThan(-1);
  });
});

describe('bulk-ai-product-faqs.ts: the catalogue-wide product FAQ sweep rejects placeholder output', () => {
  const source = readFileSync(PRODUCT_FAQS_PATH, 'utf8');

  it('imports the shared guard', () => {
    expect(source).toContain("from '../../ai/placeholder-guard'");
  });

  it('guards productFaq.createMany (question + answer per FAQ)', () => {
    const createIdx = source.indexOf('productFaq.createMany');
    expect(createIdx).toBeGreaterThan(-1);
    // The guard must run as part of building `validFaqs`, before the createMany call.
    const validFaqsIdx = source.indexOf('validFaqs');
    expect(validFaqsIdx).toBeGreaterThan(-1);
    expect(validFaqsIdx).toBeLessThan(createIdx);
    const guardIdx = source.indexOf('isPlaceholderText', validFaqsIdx);
    expect(guardIdx, 'no isPlaceholderText guard in the validFaqs filter').toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(createIdx);
  });
});
