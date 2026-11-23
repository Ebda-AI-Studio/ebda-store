/**
 * ai-run-estimate.ts - what an AI tool run will use, BEFORE the merchant presses Run.
 *
 * ONE definition, two readers. The catalogue sweeps (lib/inngest/functions/bulk-ai-*.ts) take their work set from
 * `productScope` / `categoryScope` and set the job's `total` with `aiRunTotal`; the read-only estimate route
 * (`GET /stores/:storeId/ai/bulk-estimate`) counts rows with the SAME scopes and prices them with the SAME function.
 * There is no second copy of the formula, so the number shown next to Run cannot drift from what the run charges.
 *
 * The unit is the AI CALL, the unit the merchant's daily/monthly allowance is counted in (`ai_usage` rows). Money is
 * not estimated: provider rates are env-configured and null when unset (lib/ai-pricing.ts), so a currency figure here
 * would be a guess. The figure is a CEILING: a smart-skip run fills only what is blank, so it may use fewer calls, never more.
 */

/** Which products / categories a sweep walks. `storeId` is always part of the scope (tenant isolation). */
export const productScope = {
  /** every non-deleted product */
  live: (storeId: string) => ({ storeId, deletedAt: null }),
  /** active, non-deleted products */
  active: (storeId: string) => ({ storeId, status: 'active' as const, deletedAt: null }),
  /** active products with no category */
  uncategorised: (storeId: string) => ({
    storeId,
    status: 'active' as const,
    deletedAt: null,
    categories: { none: {} },
  }),
} as const;

export const categoryScope = {
  /** every category (the translate sweep does not filter) */
  all: (storeId: string) => ({ storeId }),
  /** non-deleted categories */
  live: (storeId: string) => ({ storeId, deletedAt: null }),
} as const;

/** Image alt text is generated per image, up to this many images per product (bulk-ai-image-alt.ts). */
export const IMAGES_PER_PRODUCT_CAP = 4;

export const AI_RUN_TOOLS = [
  'translate-ar',
  'translate-en',
  'balance-descriptions',
  'revert-balance',
  'seo',
  'faq-aeo',
  'howto-aeo',
  'meta-aeo',
  'product-faqs',
  'recommendations',
  'llms-txt',
  'citation-copy',
  'brand-facts',
  'categorize',
  'image-alt',
  'excerpt',
  'tags',
  'aeo-all',
  'geo-all',
] as const;
export type AiRunTool = (typeof AI_RUN_TOOLS)[number];

/** Row counts, each taken with the scope the tool uses (see TOOL_SCOPES). */
export interface RunCounts {
  products: number;
  categories: number;
}

export interface RunOptions {
  /** FAQs requested by faq-aeo / aeo-all (the route clamps it to 1..20, default 8). */
  faqCount?: number;
  /** HowTos requested by howto-aeo (default 3). */
  howtoCount?: number;
}

export const DEFAULT_FAQ_COUNT = 8;
export const DEFAULT_HOWTO_COUNT = 3;
export const MAX_FAQ_COUNT = 20;

export type AiRunLeaf = Exclude<AiRunTool, 'aeo-all' | 'geo-all'>;
type Leaf = AiRunLeaf;

/** The scopes a leaf tool counts (null = the tool does not look at that table). */
export const TOOL_SCOPES: Record<
  Leaf,
  { products: keyof typeof productScope | null; categories: keyof typeof categoryScope | null }
> = {
  'translate-ar': { products: 'live', categories: 'all' },
  'translate-en': { products: 'live', categories: 'all' },
  'balance-descriptions': { products: 'live', categories: null },
  'revert-balance': { products: 'live', categories: null },
  seo: { products: 'live', categories: 'live' },
  'meta-aeo': { products: 'live', categories: 'live' },
  'faq-aeo': { products: null, categories: null },
  'howto-aeo': { products: null, categories: null },
  'product-faqs': { products: 'active', categories: null },
  recommendations: { products: 'active', categories: null },
  'llms-txt': { products: null, categories: null },
  'citation-copy': { products: 'live', categories: null },
  'brand-facts': { products: null, categories: null },
  categorize: { products: 'uncategorised', categories: null },
  'image-alt': { products: 'active', categories: null },
  excerpt: { products: 'active', categories: null },
  tags: { products: 'active', categories: null },
};

/** Every leaf tool a master sweep starts. */
export const MASTER_TOOLS: Record<'aeo-all' | 'geo-all', Leaf[]> = {
  'aeo-all': ['faq-aeo', 'howto-aeo', 'meta-aeo'],
  'geo-all': ['llms-txt', 'citation-copy', 'brand-facts'],
};

/** The job's `total`: the number of work units the sweep walks. The ONE formula, used by the jobs and the estimate. */
export function aiRunTotal(tool: Leaf, counts: RunCounts, opts: RunOptions = {}): number {
  const p = counts.products;
  const c = counts.categories;
  switch (tool) {
    case 'translate-ar':
    case 'translate-en':
      return (p + c + 1) * 2; // every product, category and the store row: a name and a description each
    case 'seo':
    case 'meta-aeo':
      return 1 + c + p; // the store, its categories and its products
    case 'faq-aeo':
      return opts.faqCount ?? DEFAULT_FAQ_COUNT;
    case 'howto-aeo':
      return opts.howtoCount ?? DEFAULT_HOWTO_COUNT;
    case 'llms-txt':
    case 'brand-facts':
      return 1;
    default:
      return p; // one unit per product in the tool's scope
  }
}

/** AI calls one work unit can use at most (image alt text is per image; undoing a balance run calls no model). */
function callsPerUnit(tool: Leaf): number {
  if (tool === 'image-alt') return IMAGES_PER_PRODUCT_CAP;
  if (tool === 'revert-balance') return 0;
  return 1;
}

/** Ceiling of AI calls a run of one leaf tool will use for these counts. */
export function aiRunCalls(tool: AiRunLeaf, counts: RunCounts, opts: RunOptions = {}): number {
  return aiRunTotal(tool, counts, opts) * callsPerUnit(tool);
}

/** The leaf tools a tool starts: itself, or the three a master sweep fans out to. Each is counted with its OWN scope. */
export function leavesOf(tool: AiRunTool): AiRunLeaf[] {
  return tool === 'aeo-all' || tool === 'geo-all' ? MASTER_TOOLS[tool] : [tool];
}
