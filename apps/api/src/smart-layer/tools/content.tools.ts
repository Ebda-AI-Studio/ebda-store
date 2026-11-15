/**
 * Wave 1 (plan 4 B6): content change tools. One `change()` per tool; each gate is the SAME role / permission / feature the admin route demands
 * (cited at each tool) and each `run` calls the SAME service the route calls. NEVER-OVERWRITE-1: the assistant changes merchant-written text only
 * because the merchant asked in this turn, with before/after rows and an undo that restores the old text. Deleting content is NOT here (wave 2).
 */
import { sizeChartSchema } from '@ebda/shared';
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { StoreFaqService } from '../../services/store-faq.service';
import { SizeChartService } from '../../services/size-chart.service';
import { PagesService } from '../../services/pages.service';
import { BlogService } from '../../services/blog.service';
import { change, diffRows, f, pair, pick, row, shape, type Described } from './kit';

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const defined = (o: Record<string, unknown>): string[] =>
  Object.keys(o).filter(k => o[k] !== undefined);
const subset = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.map(k => [k, o[k]]));

// ---- store FAQs -------------------------------------------------------------------------------------------------------------------------------
// routes/store.routes.ts POST/PUT /:id/faqs: authorize(store_admin, super_admin) + requireFeature('seo'). Logic = StoreFaqService (extracted from the route).
const FAQ_GATE = { roles: ['store_admin'], feature: 'seo' } as const;
const FAQ_LABELS: Record<string, [string, string]> = {
  question: ['السؤال', 'Question'],
  questionAr: ['السؤال بالعربي', 'Question (Arabic)'],
  answer: ['الإجابة', 'Answer'],
  answerAr: ['الإجابة بالعربي', 'Answer (Arabic)'],
  orderIndex: ['الترتيب', 'Order'],
  isActive: ['ظاهر في المتجر', 'Shown in the store'],
};
type FaqFields = {
  question?: string;
  questionAr?: string | null;
  answer?: string;
  answerAr?: string | null;
  orderIndex?: number;
  isActive?: boolean;
};
const faqShape = {
  question: f.str('The question', { max: 500 }),
  questionAr: f.nullable(f.text('The question in Arabic', { max: 500 })),
  answer: f.str('The answer', { max: 5000 }),
  answerAr: f.nullable(f.text('The answer in Arabic', { max: 5000 })),
  orderIndex: f.int('Position, 0 = first'),
  isActive: f.bool('false hides it from the store'),
};

type FaqCreateArgs = FaqFields & { question: string; answer: string };
const faqCreate = change<FaqCreateArgs>({
  name: 'faq_create',
  capabilityId: 'store.faqs-howtos',
  description:
    'Add one question and answer to the store FAQ (shown on the store and to AI engines). Arabic text is optional.',
  schema: shape<FaqCreateArgs>(faqShape, ['question', 'answer']),
  undo: 'compensating', // undo hides the new FAQ (isActive=false); deleting is wave 2
  gate: FAQ_GATE,
  audit: { action: 'store.faq_created', resourceType: 'store_faq' },
  state: async () => null,
  describe: (_ctx, a): Described => ({
    summary: pair(
      `هضيف سؤال جديد للأسئلة الشائعة: "${a.question}".`,
      `I will add a new FAQ: "${a.question}".`
    ),
    rows: defined(a).map(k =>
      row(FAQ_LABELS[k]![0], FAQ_LABELS[k]![1], null, (a as Record<string, unknown>)[k])
    ),
    affectedCount: 1,
    restore: null,
  }),
  run: async (ctx, a) => {
    const c = await StoreFaqService.create(ctx.storeId, a as never);
    return { faqId: (c as { id: string }).id };
  },
  inverse: (_a, _restore, result) => {
    const id = (result as { faqId?: string } | undefined)?.faqId;
    return id ? { tool: 'faq_update', args: { faqId: id, isActive: false } } : null;
  },
});

type FaqUpdateArgs = FaqFields & { faqId: string };
const faqUpdate = change<FaqUpdateArgs>({
  name: 'faq_update',
  capabilityId: 'store.faqs-howtos',
  description:
    'Change one existing FAQ (your own text). Send only the fields to change. isActive false hides it.',
  schema: shape<FaqUpdateArgs>({ faqId: f.id('The FAQ id'), ...faqShape }, ['faqId']),
  undo: 'reversible',
  gate: FAQ_GATE,
  audit: { action: 'store.faq_updated', resourceType: 'store_faq', resourceId: a => a.faqId },
  state: async (ctx, a) => {
    // 404s an id that is not this store's FAQ.
    const c = (await StoreFaqService.get(ctx.storeId, a.faqId)) as unknown as Record<
      string,
      unknown
    >;
    return { ...subset(c, Object.keys(FAQ_LABELS)), updatedAt: iso(c.updatedAt as Date) };
  },
  describe: (_ctx, a, st): Described => {
    const { faqId: _id, ...fields } = a;
    const touched = defined(fields);
    if (touched.length === 0) throw new Error('Nothing to change: send at least one field.');
    const before = st as Record<string, unknown>;
    return {
      summary: pair('هعدّل السؤال الشائع ده.', 'I will edit this FAQ.'),
      rows: diffRows(FAQ_LABELS, before, subset(fields as Record<string, unknown>, touched)),
      affectedCount: 1,
      restore: pick(before, touched),
    };
  },
  run: async (ctx, a) => {
    const { faqId, ...fields } = a;
    await StoreFaqService.update(ctx.storeId, faqId, fields as never);
    return { faqId };
  },
  inverse: (a, restore) => ({
    tool: 'faq_update',
    args: { faqId: a.faqId, ...(restore as object) },
  }),
});

// ---- size charts ------------------------------------------------------------------------------------------------------------------------------
// routes/size-chart.routes.ts writeChain: authorize(store_admin, super_admin, staff) + requirePermission('products:write').
const CHART_GATE = { permission: 'products:write' } as const;
const CHART_KEYS = ['name', 'nameAr', 'unit', 'columns', 'rows', 'note', 'noteAr'];
const CHART_LABELS: Record<string, [string, string]> = {
  name: ['اسم الجدول', 'Chart name'],
  nameAr: ['الاسم بالعربي', 'Arabic name'],
  unit: ['الوحدة', 'Unit'],
  columns: ['الأعمدة', 'Columns'],
  rows: ['الصفوف', 'Rows'],
  note: ['ملاحظة', 'Note'],
  noteAr: ['الملاحظة بالعربي', 'Arabic note'],
};
type ChartFields = {
  name?: string;
  nameAr?: string;
  unit?: 'cm' | 'in';
  columns?: Array<{ label?: string; labelAr?: string }>;
  rows?: string[][];
  note?: string;
  noteAr?: string;
};
const chartShape = {
  name: f.text('Chart name in English (name or nameAr is required)', { max: 60 }),
  nameAr: f.text('Chart name in Arabic', { max: 60 }),
  unit: f.enum(['cm', 'in']),
  columns: f.list(
    f.obj({
      label: f.text('English label', { max: 24 }),
      labelAr: f.text('Arabic label', { max: 24 }),
    }),
    {
      min: 2,
      max: 10,
      description: 'Column headers, 2 to 10',
    }
  ),
  rows: f.list(f.list(f.text('A cell, max 24 characters', { max: 24 }), { max: 10 }), {
    min: 1,
    max: 30,
    description: 'Each row needs exactly one cell per column',
  }),
  note: f.text('A short note under the chart', { max: 300 }),
  noteAr: f.text('Arabic note', { max: 300 }),
};
function parseChart(x: unknown) {
  const r = sizeChartSchema.safeParse(x);
  if (!r.success)
    throw new Error(
      `Size chart invalid: ${r.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`
    );
  return r.data;
}
const chartView = (c: Record<string, unknown>) => subset(c, CHART_KEYS);

type ChartCreateArgs = ChartFields & {
  columns: NonNullable<ChartFields['columns']>;
  rows: string[][];
};
const sizeChartCreate = change<ChartCreateArgs>({
  name: 'size_chart_create',
  capabilityId: 'store.size-charts',
  description:
    'Create a size chart (a table of sizes). Every row needs one cell per column. Attach it to products on the Size charts screen.',
  schema: shape<ChartCreateArgs>(chartShape, ['columns', 'rows']),
  undo: 'irreversible', // the chart has no hide switch and the delete tool is wave 2
  gate: CHART_GATE,
  audit: { action: 'sizeChart.created', resourceType: 'size_chart' },
  state: async () => null,
  describe: (_ctx, a): Described => {
    const chart = parseChart(a);
    return {
      summary: pair(
        `هعمل جدول مقاسات جديد "${chart.name || chart.nameAr}".`,
        `I will create the size chart "${chart.name || chart.nameAr}".`
      ),
      rows: CHART_KEYS.map(k =>
        row(CHART_LABELS[k]![0], CHART_LABELS[k]![1], null, (chart as Record<string, unknown>)[k])
      ),
      affectedCount: 1,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    const c = await SizeChartService.create(ctx.storeId, parseChart(a));
    return { chartId: (c as { id: string }).id };
  },
});

type ChartUpdateArgs = ChartFields & { chartId: string };
const sizeChartUpdate = change<ChartUpdateArgs>({
  name: 'size_chart_update',
  capabilityId: 'store.size-charts',
  description:
    'Change fields of one size chart (send only what changes; if you change columns send rows that match).',
  schema: shape<ChartUpdateArgs>({ chartId: f.id('The size chart id'), ...chartShape }, [
    'chartId',
  ]),
  undo: 'reversible',
  gate: CHART_GATE,
  audit: { action: 'sizeChart.updated', resourceType: 'size_chart', resourceId: a => a.chartId },
  state: async (ctx, a) => {
    // 404s a chart that is not this store's.
    const c = (await SizeChartService.get(ctx.storeId, a.chartId)) as unknown as Record<
      string,
      unknown
    >;
    return { ...chartView(c), updatedAt: iso(c.updatedAt as Date) };
  },
  describe: (_ctx, a, st): Described => {
    const { chartId: _id, ...fields } = a;
    const touched = defined(fields);
    if (touched.length === 0) throw new Error('Nothing to change: send at least one field.');
    const before = st as Record<string, unknown>;
    const merged = parseChart({
      ...chartView(before),
      ...subset(fields as Record<string, unknown>, touched),
    });
    const nm = String(before.name || before.nameAr);
    return {
      summary: pair(`هعدّل جدول المقاسات "${nm}".`, `I will edit the size chart "${nm}".`),
      rows: diffRows(CHART_LABELS, before, subset(merged as Record<string, unknown>, touched)),
      affectedCount: 1,
      restore: pick(before, touched),
    };
  },
  run: async (ctx, a, st) => {
    const { chartId, ...fields } = a;
    const merged = parseChart({ ...chartView(st as Record<string, unknown>), ...defOnly(fields) });
    await SizeChartService.update(ctx.storeId, chartId, merged);
    return { chartId };
  },
  inverse: (a, restore) => ({
    tool: 'size_chart_update',
    args: { chartId: a.chartId, ...(restore as object) },
  }),
});
const defOnly = (o: Record<string, unknown>) => subset(o, defined(o));

// ---- the store's own policy pages -------------------------------------------------------------------------------------------------------------
// routes/pages.routes.ts PUT /stores/:storeId/pages/:slug: authorize(store_admin, super_admin) (+ MFA enrolment at login). Logic = PagesService.upsert.
// Only the merchant's own store pages; the platform's legal notices (legal-policy.routes.ts, super admin) are never reachable from here.
type Block = Record<string, unknown>;
type LegalArgs = {
  slug: 'privacy' | 'terms' | 'shipping' | 'returns';
  title?: string | null;
  titleAr?: string | null;
  contentBlocks?: Block[] | null;
  contentBlocksAr?: Block[] | null;
  isPublished?: boolean;
};
const LEGAL_LABELS: Record<string, [string, string]> = {
  title: ['العنوان', 'Title'],
  titleAr: ['العنوان بالعربي', 'Title (Arabic)'],
  contentBlocks: ['نص الصفحة (إنجليزي)', 'Page text (English)'],
  contentBlocksAr: ['نص الصفحة (عربي)', 'Page text (Arabic)'],
  isPublished: ['منشورة', 'Published'],
};
const blockShape = {
  type: f.enum(['heading', 'paragraph', 'bullets', 'numbered'], 'Block kind'),
  level: f.int('Heading level 2 or 3', { min: 2, max: 3 }),
  text: f.text('Heading or paragraph text', { max: 10000 }),
  items: f.list(f.text('One list item', { max: 2000 }), { max: 100 }),
};
function assertBlocks(blocks: Block[] | null | undefined): void {
  for (const b of blocks ?? []) {
    const ok =
      (b.type === 'heading' && typeof b.text === 'string' && (b.level === 2 || b.level === 3)) ||
      (b.type === 'paragraph' && typeof b.text === 'string') ||
      ((b.type === 'bullets' || b.type === 'numbered') && Array.isArray(b.items));
    if (!ok) throw new Error(`Invalid page block: ${JSON.stringify(b).slice(0, 80)}`);
  }
}
const legalBlocks = (d: string) =>
  f.nullable(f.list(f.obj(blockShape, ['type']), { max: 200, description: d }));
const legalPageUpdate = change<LegalArgs>({
  name: 'legal_page_update',
  capabilityId: 'store.legal-pages',
  description:
    "Edit the store's own policy page text (privacy, terms, shipping, returns). contentBlocks = the page body as blocks: {type:'heading',level:2|3,text} | {type:'paragraph',text} | {type:'bullets'|'numbered',items:[...]}. It REPLACES that language's body, so send the whole text.",
  schema: shape<LegalArgs>(
    {
      slug: f.enum(['privacy', 'terms', 'shipping', 'returns'], 'Which policy page'),
      title: f.nullable(f.text('Page title', { max: 300 })),
      titleAr: f.nullable(f.text('Page title in Arabic', { max: 300 })),
      contentBlocks: legalBlocks('English body'),
      contentBlocksAr: legalBlocks('Arabic body'),
      isPublished: f.bool('false hides the page'),
    },
    ['slug']
  ),
  undo: 'reversible',
  gate: { roles: ['store_admin'] },
  audit: { action: 'store.page_updated', resourceType: 'store_page', resourceId: a => a.slug },
  state: async (ctx, a) => {
    const p = (await PagesService.get(ctx.storeId, a.slug)) as unknown as Record<
      string,
      unknown
    > | null;
    return p
      ? {
          exists: true,
          ...subset(p, Object.keys(LEGAL_LABELS)),
          updatedAt: iso(p.updatedAt as Date),
        }
      : { exists: false, ...Object.fromEntries(Object.keys(LEGAL_LABELS).map(k => [k, null])) };
  },
  describe: (_ctx, a, st): Described => {
    const { slug, ...fields } = a;
    const touched = defined(fields);
    if (touched.length === 0) throw new Error('Nothing to change: send at least one field.');
    assertBlocks(a.contentBlocks);
    assertBlocks(a.contentBlocksAr);
    const before = st as Record<string, unknown>;
    return {
      summary: pair(
        `هغيّر نص صفحة "${slug}" بتاعة متجرك. النص القديم هيتحفظ وتقدر ترجّعه.`,
        `I will change the text of your "${slug}" page. The old text is kept and you can undo.`
      ),
      rows: diffRows(LEGAL_LABELS, before, subset(fields as Record<string, unknown>, touched)),
      affectedCount: 1,
      restore: pick(before, touched),
    };
  },
  run: async (ctx, a) => {
    const { slug, ...fields } = a;
    await PagesService.upsert(ctx.storeId, slug, defOnly(fields) as never);
    return { slug };
  },
  inverse: (a, restore) => ({
    tool: 'legal_page_update',
    args: { slug: a.slug, ...(restore as object) },
  }),
});

// ---- blog (drafts only) -----------------------------------------------------------------------------------------------------------------------
// routes/blog.routes.ts POST /stores/:storeId/blog: authorize(store_admin, super_admin, staff). Logic = BlogService.create with isPublished false, always.
type BlogArgs = {
  slug: string;
  title: string;
  titleAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  content: string;
  contentAr?: string | null;
};
const blogPostDraft = change<BlogArgs>({
  name: 'blog_post_draft',
  capabilityId: 'store.blog',
  description:
    'Write a blog post as a DRAFT. It is never published by the assistant: the merchant publishes it on the Blog screen. slug = lowercase letters, digits, dashes.',
  schema: shape<BlogArgs>(
    {
      slug: f.str('URL slug', { max: 80 }),
      title: f.str('Title', { max: 200 }),
      titleAr: f.nullable(f.text('Arabic title', { max: 200 })),
      excerpt: f.nullable(f.text('Short summary', { max: 500 })),
      excerptAr: f.nullable(f.text('Arabic summary', { max: 500 })),
      content: f.str('The post body', { max: 50000 }),
      contentAr: f.nullable(f.text('Arabic body', { max: 50000 })),
    },
    ['slug', 'title', 'content']
  ),
  undo: 'compensating', // undo discards the draft through blog_post_discard_draft (confirm-class: it deletes)
  gate: { roles: ['store_admin', 'staff'] },
  audit: { action: 'blog.draft_created', resourceType: 'blog_post' },
  state: async () => null,
  describe: (_ctx, a): Described => ({
    summary: pair(
      `هكتب مقال "${a.title}" كمسودة. مش هيتنشر لحد ما انت تنشره.`,
      `I will write the post "${a.title}" as a draft. It is not published until you publish it.`
    ),
    rows: [
      row('العنوان', 'Title', null, a.title),
      row('الرابط', 'Slug', null, a.slug),
      row(
        'المحتوى',
        'Body',
        null,
        a.content.length > 300 ? `${a.content.slice(0, 300)}...` : a.content
      ),
      row('منشور', 'Published', null, false),
    ],
    affectedCount: 1,
    restore: null,
  }),
  run: async (ctx, a) => {
    const p = await BlogService.create(ctx.storeId, { ...a, isPublished: false } as never);
    return { postId: (p as { id: string }).id };
  },
  inverse: (_a, _restore, result) => {
    const id = (result as { postId?: string } | undefined)?.postId;
    return id ? { tool: 'blog_post_discard_draft', args: { postId: id } } : null;
  },
});

type DiscardArgs = { postId: string };
const blogPostDiscardDraft = change<DiscardArgs>({
  name: 'blog_post_discard_draft',
  capabilityId: 'store.blog',
  description:
    'Delete ONE blog post that is still a DRAFT (never a published post). Used to undo blog_post_draft; the merchant can also ask for it.',
  schema: shape<DiscardArgs>({ postId: f.id('The draft post id') }, ['postId']),
  policy: 'confirm',
  undo: 'irreversible',
  deletes: true,
  // routes/blog.routes.ts DELETE /stores/:storeId/blog/:postId: authorize(store_admin, super_admin, staff). Logic = BlogService.remove.
  gate: { roles: ['store_admin', 'staff'] },
  audit: { action: 'blog.draft_discarded', resourceType: 'blog_post', resourceId: a => a.postId },
  state: async (ctx, a) => {
    // 404s a post that is not this store's.
    const p = (await BlogService.getById(ctx.storeId, a.postId)) as unknown as Record<
      string,
      unknown
    >;
    return {
      id: p.id,
      title: p.title,
      isPublished: p.isPublished,
      updatedAt: iso(p.updatedAt as Date),
    };
  },
  describe: (_ctx, _a, st): Described => {
    const p = st as { title: string; isPublished: boolean };
    if (p.isPublished) throw new Error('Only a draft can be discarded; this post is published.');
    return {
      summary: pair(
        `همسح مسودة المقال "${p.title}".`,
        `I will delete the draft post "${p.title}".`
      ),
      rows: [row('المسودة', 'Draft', p.title, null)],
      affectedCount: 1,
      restore: null,
    };
  },
  run: async (ctx, a, st) => {
    if ((st as { isPublished: boolean }).isPublished)
      throw new Error('Only a draft can be discarded.');
    await BlogService.remove(ctx.storeId, a.postId);
    return { postId: a.postId };
  },
});

export function contentTools(): ToolSpec[] {
  return [
    faqCreate,
    faqUpdate,
    sizeChartCreate,
    sizeChartUpdate,
    legalPageUpdate,
    blogPostDraft,
    blogPostDiscardDraft,
  ];
}
