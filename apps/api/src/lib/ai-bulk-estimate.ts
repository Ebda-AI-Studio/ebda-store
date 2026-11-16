/**
 * How many AI requests a bulk sweep will make (G18). An UPPER BOUND: the sweeps smart-skip rows that are already
 * filled, so the real number is usually lower; the estimate must never be lower than what the run can spend.
 *
 *  - `{ perProduct: n }`: n model calls per active product (a master sweep fans out into several per-product jobs)
 *  - `{ fixed: n }`: n calls for the whole store (llms.txt, brand facts, citation copy), 0 for a revert
 */
type Shape = { perProduct: number } | { fixed: number };

const BULK_AI_ESTIMATE: Record<string, Shape> = {
  translate: { perProduct: 1 },
  'balance-descriptions': { perProduct: 1 },
  'revert-balance': { fixed: 0 },
  seo: { perProduct: 1 },
  recommendations: { perProduct: 1 },
  'faq-aeo': { perProduct: 1 },
  'howto-aeo': { perProduct: 1 },
  'meta-aeo': { perProduct: 1 },
  'product-faqs': { perProduct: 1 },
  'aeo-sweep-all': { perProduct: 3 },
  'llms-txt': { fixed: 1 },
  'citation-copy': { fixed: 1 },
  'brand-facts': { fixed: 1 },
  'geo-sweep-all': { fixed: 3 },
  categorize: { perProduct: 1 },
  'image-alt': { perProduct: 1 },
  excerpt: { perProduct: 1 },
  tags: { perProduct: 1 },
};

export function isBulkAiKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(BULK_AI_ESTIMATE, kind);
}

export function estimateBulkAiRequests(kind: string, products: number): number {
  const shape = BULK_AI_ESTIMATE[kind];
  if (!shape) throw new Error(`unknown bulk AI kind: ${kind}`);
  return 'perProduct' in shape ? shape.perProduct * Math.max(0, products) : shape.fixed;
}
