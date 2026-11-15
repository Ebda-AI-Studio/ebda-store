/**
 * The AI tools page, as data: which tools exist, how they are grouped, what each one costs and whether it can
 * replace content. The page renders from this list, so every card is built the same way and a new tool is one row.
 *
 * Request shapes are exactly the ones the page sent before the redesign (endpoint + body); only the presentation moved.
 */

export type StartKey =
  | 'translate-ar'
  | 'translate-en'
  | 'balance-descriptions'
  | 'revert-balance'
  | 'seo'
  | 'faq-aeo'
  | 'howto-aeo'
  | 'meta-aeo'
  | 'product-faqs'
  | 'aeo-all'
  | 'recommendations'
  | 'llms-txt'
  | 'citation-copy'
  | 'brand-facts'
  | 'geo-all'
  | 'categorize'
  | 'image-alt'
  | 'excerpt'
  | 'tags';

/** How many AI calls a run uses, in words a merchant can weigh against their allowance. */
type CostClass = 'one' | 'few' | 'perProduct' | 'perItem' | 'perImage' | 'none';

export interface ToolSpec {
  key: StartKey;
  /** i18n group: `aiTools.cards.<copy>.{title,outcome,body,button,forceTooltip}` */
  copy: string;
  endpoint: string;
  body?: Record<string, unknown>;
  cost: CostClass;
  /**
   * Whether the server can overwrite existing content for this tool. `false` = it only ever fills blanks, so the page
   * offers no "replace" switch. Translate, categorize and image alt replace with a backup (Ruling AITOOLS-4).
   */
  canReplace: boolean;
  /** A replace run can be rolled back from the page (language balance: its own Undo tool; the AITOOLS-4 tools: the run history). */
  undoable?: boolean;
  /** The undo tool: styled as a secondary action, labelled as undo. */
  isUndo?: boolean;
  /** Where the merchant sees the output, for tools that write to another admin page. */
  resultsPath?: string;
}

interface MasterSpec {
  key: 'aeo-all' | 'geo-all';
  endpoint: string;
  body: Record<string, unknown>;
}

interface ToolSection {
  id: string;
  /** `aiTools.sections.<id>` title and `aiTools.sectionsDesc.<id>` one-line description */
  copyKey: string;
  tools: ToolSpec[];
  master?: MasterSpec;
}

export const TOOL_SECTIONS: ToolSection[] = [
  {
    id: 'translation',
    copyKey: 'translation',
    tools: [
      {
        key: 'translate-ar',
        copy: 'fillMissingArabic',
        endpoint: '/bulk/translate',
        body: { direction: 'to_ar' },
        cost: 'perItem',
        canReplace: true,
        undoable: true,
      },
      {
        key: 'translate-en',
        copy: 'fillMissingEnglish',
        endpoint: '/bulk/translate',
        body: { direction: 'to_en' },
        cost: 'perItem',
        canReplace: true,
        undoable: true,
      },
    ],
  },
  {
    id: 'balance',
    copyKey: 'descriptionBalance',
    tools: [
      {
        key: 'balance-descriptions',
        copy: 'balanceDescriptions',
        endpoint: '/bulk/balance-descriptions',
        cost: 'perProduct',
        canReplace: true,
        undoable: true,
      },
      {
        key: 'revert-balance',
        copy: 'revertBalance',
        endpoint: '/bulk/revert-balance',
        cost: 'none',
        canReplace: true,
        undoable: true,
        isUndo: true,
      },
    ],
  },
  {
    id: 'seo',
    copyKey: 'seo',
    tools: [
      { key: 'seo', copy: 'seoMeta', endpoint: '/bulk/seo', cost: 'perItem', canReplace: true },
      {
        key: 'recommendations',
        copy: 'recommendations',
        endpoint: '/bulk/recommendations',
        cost: 'perProduct',
        canReplace: true,
      },
    ],
  },
  {
    id: 'aeo',
    copyKey: 'aeo',
    master: { key: 'aeo-all', endpoint: '/bulk/aeo-sweep-all', body: { count: 8 } },
    tools: [
      {
        key: 'faq-aeo',
        copy: 'draftFaqs',
        endpoint: '/bulk/faq-aeo',
        body: { count: 8 },
        cost: 'few',
        canReplace: true,
        resultsPath: '/seo#faqs',
      },
      {
        key: 'howto-aeo',
        copy: 'draftHowtos',
        endpoint: '/bulk/howto-aeo',
        body: { count: 3 },
        cost: 'few',
        canReplace: true,
        resultsPath: '/seo#howtos',
      },
      {
        key: 'meta-aeo',
        copy: 'metaAeo',
        endpoint: '/bulk/meta-aeo',
        cost: 'perItem',
        canReplace: true,
        resultsPath: '/seo',
      },
      {
        key: 'product-faqs',
        copy: 'productFaqs',
        endpoint: '/bulk/product-faqs',
        cost: 'perProduct',
        canReplace: true,
      },
    ],
  },
  {
    id: 'geo',
    copyKey: 'geo',
    master: { key: 'geo-all', endpoint: '/bulk/geo-sweep-all', body: {} },
    tools: [
      {
        key: 'llms-txt',
        copy: 'llmsTxt',
        endpoint: '/bulk/llms-txt',
        cost: 'one',
        canReplace: true,
      },
      {
        key: 'citation-copy',
        copy: 'citationCopy',
        endpoint: '/bulk/citation-copy',
        cost: 'perProduct',
        canReplace: true,
      },
      {
        key: 'brand-facts',
        copy: 'brandFacts',
        endpoint: '/bulk/brand-facts',
        cost: 'one',
        canReplace: true,
      },
    ],
  },
  {
    id: 'fields',
    copyKey: 'catalogueFields',
    tools: [
      {
        key: 'categorize',
        copy: 'categorize',
        endpoint: '/bulk/categorize',
        cost: 'perProduct',
        canReplace: true,
        undoable: true,
      },
      {
        key: 'image-alt',
        copy: 'imageAlt',
        endpoint: '/bulk/image-alt',
        cost: 'perImage',
        canReplace: true,
        undoable: true,
      },
      {
        key: 'excerpt',
        copy: 'excerpt',
        endpoint: '/bulk/excerpt',
        cost: 'perProduct',
        canReplace: true,
      },
      {
        key: 'tags',
        copy: 'productTags',
        endpoint: '/bulk/tags',
        cost: 'perProduct',
        canReplace: true,
      },
    ],
  },
];

type BlockReason = 'off' | 'daily' | 'monthly' | null;

interface QuotaLike {
  today: number;
  thisMonth: number;
  dailyCap: number;
  monthlyCap: number;
}

/**
 * Why a run cannot start right now, or null. A cap of 0 or less is treated as "not enforced here": the server stays
 * the authority (it refuses with its own message), the page only avoids offering a button that is certain to fail.
 */
export function blockReasonFor(summary: QuotaLike | null, aiEnabled: boolean | null): BlockReason {
  if (aiEnabled === false) return 'off';
  if (!summary) return null;
  if (summary.dailyCap > 0 && summary.today >= summary.dailyCap) return 'daily';
  if (summary.monthlyCap > 0 && summary.thisMonth >= summary.monthlyCap) return 'monthly';
  return null;
}
