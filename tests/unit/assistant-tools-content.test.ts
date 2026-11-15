/**
 * Content change tools of the Store assistant (plan 4 B6): store FAQs, size charts, the store's own policy pages, blog drafts.
 * NEVER-OVERWRITE-1: existing merchant text is only changed on request, with before/after rows and an undo that restores it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  faq: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
  chart: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
  pages: { get: vi.fn(), upsert: vi.fn() },
  blog: { create: vi.fn(), getById: vi.fn(), remove: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: m.auditLog }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/store-faq.service', () => ({ StoreFaqService: m.faq }));
vi.mock('@api/services/size-chart.service', () => ({ SizeChartService: m.chart }));
vi.mock('@api/services/pages.service', () => ({ PagesService: m.pages }));
vi.mock('@api/services/blog.service', () => ({ BlogService: m.blog }));

import { ToolForbidden } from '@ebda/shared/smart-layer';
import { contentTools } from '@api/smart-layer/tools/content.tools';
import { applyOf, ctxOf, previewOf, toolNamed } from './helpers/assistant-tool-harness';
import { applyThenUndo } from './helpers/undo-roundtrip';

const tools = contentTools();
const T = (n: string) => toolNamed(tools, n);
const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });
const undoArgs = (t: ReturnType<typeof T>, a: unknown, draft: never, applied: never) =>
  t.inverse!(ctxOf(), a as never, draft, applied);

const faq = {
  id: 'f1',
  question: 'Q?',
  questionAr: null,
  answer: 'A',
  answerAr: null,
  orderIndex: 0,
  isActive: true,
  manuallyEdited: true,
  updatedAt: new Date(0),
};
const chart = {
  id: 'sc1',
  name: 'Tops',
  nameAr: '',
  unit: 'cm',
  columns: [
    { label: 'Size', labelAr: '' },
    { label: 'Chest', labelAr: '' },
  ],
  rows: [['S', '90']],
  note: '',
  noteAr: '',
  updatedAt: new Date(0),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.auditLog.mockResolvedValue(undefined);
  m.faq.get.mockResolvedValue(faq);
  m.faq.create.mockResolvedValue({ ...faq, id: 'f-new' });
  m.faq.update.mockResolvedValue(faq);
  m.chart.get.mockResolvedValue(chart);
  m.chart.create.mockResolvedValue({ ...chart, id: 'sc-new' });
  m.chart.update.mockResolvedValue(chart);
  m.pages.get.mockResolvedValue({
    slug: 'privacy',
    title: 'Privacy',
    titleAr: null,
    contentBlocks: [{ type: 'paragraph', text: 'old' }],
    contentBlocksAr: null,
    isPublished: true,
    updatedAt: new Date(0),
  });
  m.pages.upsert.mockResolvedValue({});
  m.blog.create.mockResolvedValue({ id: 'b1' });
  m.blog.getById.mockResolvedValue({
    id: 'b1',
    title: 'T',
    isPublished: false,
    updatedAt: new Date(0),
  });
});

describe('every content tool', () => {
  it('is declared with preview policy and no store id argument', () => {
    expect(tools.map(t => t.name).sort()).toEqual(
      [
        'blog_post_discard_draft',
        'blog_post_draft',
        'faq_create',
        'faq_update',
        'legal_page_update',
        'size_chart_create',
        'size_chart_update',
      ].sort()
    );
    for (const t of tools) {
      expect(t.policy).toBe(t.name === 'blog_post_discard_draft' ? 'confirm' : 'preview');
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });
});

describe('faq_update', () => {
  const args = { faqId: 'f1', answer: 'New answer' };
  it('shows the merchant before/after text and restores it on undo', async () => {
    const t = T('faq_update');
    const { draft, applied } = await applyOf(t, args);
    expect(draft.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(draft.rows).toEqual([expect.objectContaining({ before: 'A', after: 'New answer' })]);
    expect(m.faq.update).toHaveBeenCalledWith('s1', 'f1', { answer: 'New answer' });
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    expect(undoArgs(t, args, draft as never, applied as never)).toEqual({
      tool: 'faq_update',
      args: { faqId: 'f1', answer: 'A' },
    });
  });
  it('a foreign id throws and never reaches run; staff cannot apply', async () => {
    m.faq.get.mockRejectedValue(notFound());
    await expect(applyOf(T('faq_update'), args)).rejects.toThrow();
    expect(m.faq.update).not.toHaveBeenCalled();
    m.faq.get.mockResolvedValue(faq);
    await expect(applyOf(T('faq_update'), args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.faq.update).not.toHaveBeenCalled();
  });
  it('a hand edit changes the etag', async () => {
    const a = await previewOf(T('faq_update'), args);
    m.faq.get.mockResolvedValue({ ...faq, updatedAt: new Date(5) });
    expect((await previewOf(T('faq_update'), args)).etag).not.toBe(a.etag);
  });
});

describe('faq_create', () => {
  const args = { question: 'Do you ship?', answer: 'Yes' };
  it('is compensating: undo hides the new FAQ', async () => {
    const t = T('faq_create');
    expect(t.undo).toBe('compensating');
    const { draft, applied } = await applyOf(t, args);
    expect(m.faq.create).toHaveBeenCalledWith('s1', expect.objectContaining(args));
    expect(undoArgs(t, args, draft as never, applied as never)).toEqual({
      tool: 'faq_update',
      args: { faqId: 'f-new', isActive: false },
    });
  });
  it('staff cannot apply', async () => {
    await expect(applyOf(T('faq_create'), args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.faq.create).not.toHaveBeenCalled();
  });
});

describe('size charts', () => {
  const full = {
    name: 'Bottoms',
    unit: 'cm',
    columns: [{ label: 'Size' }, { label: 'Waist' }],
    rows: [['M', '80']],
  };
  it('size_chart_create validates with the shared schema and is irreversible', async () => {
    const t = T('size_chart_create');
    expect(t.undo).toBe('irreversible');
    await expect(previewOf(t, { ...full, rows: [['M']] })).rejects.toThrow();
    await applyOf(t, full);
    expect(m.chart.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ name: 'Bottoms', unit: 'cm' })
    );
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('size_chart_update merges onto the current chart, and undo restores the before values', async () => {
    const t = T('size_chart_update');
    const args = {
      chartId: 'sc1',
      rows: [
        ['S', '90'],
        ['M', '95'],
      ],
    };
    const { draft, applied } = await applyOf(t, args);
    expect(m.chart.update).toHaveBeenCalledWith(
      's1',
      'sc1',
      expect.objectContaining({ name: 'Tops', rows: args.rows })
    );
    expect(draft.rows).toEqual([
      expect.objectContaining({ before: [['S', '90']], after: args.rows }),
    ]);
    expect(undoArgs(t, args, draft as never, applied as never)).toEqual({
      tool: 'size_chart_update',
      args: { chartId: 'sc1', rows: [['S', '90']] },
    });
  });
  it('a foreign chart never reaches run; staff keep products:write and may apply', async () => {
    m.chart.get.mockRejectedValue(notFound());
    await expect(applyOf(T('size_chart_update'), { chartId: 'x', note: 'n' })).rejects.toThrow();
    expect(m.chart.update).not.toHaveBeenCalled();
    m.chart.get.mockResolvedValue(chart);
    await applyOf(T('size_chart_update'), { chartId: 'sc1', note: 'n' }, 'staff');
    expect(m.chart.update).toHaveBeenCalled();
    await expect(
      applyOf(T('size_chart_update'), { chartId: 'sc1', note: 'n' }, 'customer')
    ).rejects.toBeInstanceOf(ToolForbidden);
  });
});

describe('legal_page_update', () => {
  const args = { slug: 'privacy', contentBlocks: [{ type: 'paragraph', text: 'new policy' }] };
  it('shows the old and new text, writes through PagesService and restores the old blocks', async () => {
    const t = T('legal_page_update');
    const { draft, applied } = await applyOf(t, args);
    expect(m.pages.upsert).toHaveBeenCalledWith('s1', 'privacy', {
      contentBlocks: args.contentBlocks,
    });
    expect(draft.rows[0]).toMatchObject({
      before: [{ type: 'paragraph', text: 'old' }],
      after: args.contentBlocks,
    });
    expect(undoArgs(t, args, draft as never, applied as never)).toEqual({
      tool: 'legal_page_update',
      args: { slug: 'privacy', contentBlocks: [{ type: 'paragraph', text: 'old' }] },
    });
  });
  it('only the store policy pages: a platform notice slug is not accepted', () => {
    expect(
      T('legal_page_update').args.safeParse({ slug: 'legal-policies', title: 'x' }).success
    ).toBe(false);
    expect(T('legal_page_update').args.safeParse({ slug: 'terms', title: 'x' }).success).toBe(true);
  });
  it('staff cannot apply (owners only, like the route)', async () => {
    await expect(applyOf(T('legal_page_update'), args, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.pages.upsert).not.toHaveBeenCalled();
  });
});

describe('blog_post_draft', () => {
  const args = { slug: 'eid-gifts', title: 'Eid gifts', content: 'Ideas...' };
  it('always creates a DRAFT, never publishes, and says so', async () => {
    const t = T('blog_post_draft');
    const { draft, applied } = await applyOf(
      { ...t } as never,
      { ...args, isPublished: true } as never
    );
    expect(m.blog.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ slug: 'eid-gifts', isPublished: false })
    );
    expect(draft.rows.some(r => r.after === false)).toBe(true);
    expect(t.jsonSchema).not.toMatchObject({ properties: { isPublished: expect.anything() } });
  });
  it('is compensating: undo discards the draft; staff may draft', async () => {
    const t = T('blog_post_draft');
    expect(t.undo).toBe('compensating');
    const { draft, applied } = await applyOf(t, args, 'staff');
    expect(undoArgs(t, args, draft as never, applied as never)).toEqual({
      tool: 'blog_post_discard_draft',
      args: { postId: 'b1' },
    });
    expect(m.blog.create).toHaveBeenCalled();
    await expect(applyOf(T('blog_post_draft'), args, 'customer')).rejects.toBeInstanceOf(
      ToolForbidden
    );
  });
});

describe('blog_post_discard_draft', () => {
  const args = { postId: 'b1' };
  it('is confirm-class and flagged as a delete', () => {
    const t = T('blog_post_discard_draft');
    expect(t.policy).toBe('confirm');
    expect(t.deletes).toBe(true);
  });
  it('removes a draft through BlogService with the assistant audit', async () => {
    await applyOf(T('blog_post_discard_draft'), args);
    expect(m.blog.remove).toHaveBeenCalledWith('s1', 'b1');
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('never deletes a published post', async () => {
    m.blog.getById.mockResolvedValue({
      id: 'b1',
      title: 'T',
      isPublished: true,
      updatedAt: new Date(0),
    });
    await expect(applyOf(T('blog_post_discard_draft'), args)).rejects.toThrow(/draft/);
    expect(m.blog.remove).not.toHaveBeenCalled();
  });
  it('a foreign post never reaches run; customers refused', async () => {
    m.blog.getById.mockRejectedValue(notFound());
    await expect(applyOf(T('blog_post_discard_draft'), args)).rejects.toThrow();
    expect(m.blog.remove).not.toHaveBeenCalled();
    m.blog.getById.mockResolvedValue({
      id: 'b1',
      title: 'T',
      isPublished: false,
      updatedAt: new Date(0),
    });
    await expect(applyOf(T('blog_post_discard_draft'), args, 'customer')).rejects.toBeInstanceOf(
      ToolForbidden
    );
  });
});

describe('undo args pass their own tool validation (no database null into a non-null field)', () => {
  it('legal_page_update on a page that does not exist yet: the undo restores "published, empty" (same as no page)', async () => {
    m.pages.get.mockResolvedValue(null);
    const t = T('legal_page_update');
    const a = {
      slug: 'terms',
      contentBlocks: [{ type: 'paragraph', text: 'x' }],
      isPublished: false,
    };
    const { draft, applied } = await applyOf(t, a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(inv.args).toEqual({
      slug: 'terms',
      contentBlocks: null,
      isPublished: true,
    });
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });
  it('legal_page_update keeps image and button blocks restorable and drops unknown keys', async () => {
    m.pages.get.mockResolvedValue({
      slug: 'privacy',
      title: null,
      titleAr: null,
      contentBlocks: [
        { type: 'image', url: 'https://x/y.png', alt: 'a', junk: 1 },
        { type: 'button', label: 'Go', url: '/shop' },
        { type: 'bullets', items: ['a'] },
      ],
      contentBlocksAr: null,
      isPublished: true,
      updatedAt: new Date(0),
    });
    const t = T('legal_page_update');
    const a = { slug: 'privacy', contentBlocks: [{ type: 'paragraph', text: 'new' }] };
    const { draft, applied } = await applyOf(t, a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(inv.args).toEqual({
      slug: 'privacy',
      contentBlocks: [
        { type: 'image', url: 'https://x/y.png', alt: 'a' },
        { type: 'button', label: 'Go', url: '/shop' },
        { type: 'bullets', items: ['a'] },
      ],
    });
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });
  it('size_chart_update restores nulls the database holds as empty strings', async () => {
    m.chart.get.mockResolvedValue({
      ...chart,
      nameAr: null,
      note: null,
      noteAr: null,
      columns: [{ label: 'Size', labelAr: null }, { label: 'Chest' }],
    });
    const t = T('size_chart_update');
    const a = {
      chartId: 'sc1',
      nameAr: 'عربي',
      note: 'n',
      columns: [{ label: 'A' }, { label: 'B' }],
      rows: [['1', '2']],
    };
    const { draft, applied } = await applyOf(t, a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(inv.args).toMatchObject({ chartId: 'sc1', nameAr: '', note: '' });
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });
  it('faq_update restores a null Arabic answer (nullable field)', async () => {
    const t = T('faq_update');
    const a = { faqId: 'f1', answerAr: 'جديد', questionAr: 'س' };
    const { draft, applied } = await applyOf(t, a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(inv.args).toEqual({ faqId: 'f1', answerAr: null, questionAr: null });
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });
});

describe('applyThenUndo: every create tool of this slice, through the real engine', () => {
  it('faq_create: the undo (hide it) is undone', async () => {
    const r = await applyThenUndo(tools, T('faq_create'), { question: 'Q?', answer: 'A' });
    expect(r).toMatchObject({ applied: 'applied', undo: 'undone' });
  });
  it('blog_post_draft: the undo (discard the draft) needs its own confirm card', async () => {
    const r = await applyThenUndo(tools, T('blog_post_draft'), {
      slug: 'a-b',
      title: 'T',
      content: 'C',
    });
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('needs_confirm');
    expect(r.card).toBeTruthy();
  });
  it('size_chart_create is irreversible: applied, and the undo says so', async () => {
    const r = await applyThenUndo(tools, T('size_chart_create'), {
      name: 'T',
      columns: [{ label: 'a' }, { label: 'b' }],
      rows: [['1', '2']],
    });
    expect(r).toMatchObject({ applied: 'applied', undo: 'irreversible' });
  });
  it('legal_page_update on a missing page is undone (restored to published-empty)', async () => {
    m.pages.get.mockResolvedValue(null);
    const r = await applyThenUndo(tools, T('legal_page_update'), {
      slug: 'terms',
      contentBlocks: [{ type: 'paragraph', text: 'x' }],
    });
    expect(r).toMatchObject({ applied: 'applied', undo: 'undone' });
  });
  it('faq_update and size_chart_update are undone', async () => {
    expect(await applyThenUndo(tools, T('faq_update'), { faqId: 'f1', answer: 'N' })).toMatchObject(
      { undo: 'undone' }
    );
    expect(
      await applyThenUndo(tools, T('size_chart_update'), { chartId: 'sc1', note: 'n' })
    ).toMatchObject({ undo: 'undone' });
  });
});

describe('every content tool: role, plan feature and impersonation gates', () => {
  type Case = {
    tool: string;
    args: unknown;
    feature: boolean;
    staffMay: boolean;
    run: () => ReturnType<typeof vi.fn>;
    read: () => ReturnType<typeof vi.fn> | null;
  };
  const cases: Case[] = [
    {
      tool: 'faq_create',
      args: { question: 'Q', answer: 'A' },
      feature: true,
      staffMay: false,
      run: () => m.faq.create,
      read: () => null,
    },
    {
      tool: 'faq_update',
      args: { faqId: 'f1', answer: 'N' },
      feature: true,
      staffMay: false,
      run: () => m.faq.update,
      read: () => m.faq.get,
    },
    {
      tool: 'size_chart_create',
      args: { name: 'T', columns: [{ label: 'a' }, { label: 'b' }], rows: [['1', '2']] },
      feature: false,
      staffMay: true,
      run: () => m.chart.create,
      read: () => null,
    },
    {
      tool: 'size_chart_update',
      args: { chartId: 'sc1', note: 'n' },
      feature: false,
      staffMay: true,
      run: () => m.chart.update,
      read: () => m.chart.get,
    },
    {
      tool: 'legal_page_update',
      args: { slug: 'terms', title: 'T' },
      feature: false,
      staffMay: false,
      run: () => m.pages.upsert,
      read: () => m.pages.get,
    },
    {
      tool: 'blog_post_draft',
      args: { slug: 'a', title: 'T', content: 'C' },
      feature: false,
      staffMay: true,
      run: () => m.blog.create,
      read: () => null,
    },
    {
      tool: 'blog_post_discard_draft',
      args: { postId: 'b1' },
      feature: false,
      staffMay: true,
      run: () => m.blog.remove,
      read: () => m.blog.getById,
    },
  ];
  const untouched = (c: Case) => {
    expect(c.run()).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  };
  describe.each(cases)('$tool', c => {
    it('a role without the route permission is refused at PREVIEW (no card, nothing read)', async () => {
      const roles = c.staffMay ? ['customer'] : ['staff', 'customer'];
      for (const role of roles) {
        await expect(previewOf(T(c.tool), c.args, role)).rejects.toThrow(/FORBIDDEN/);
        if (c.read()) expect(c.read()).not.toHaveBeenCalled();
      }
      untouched(c);
    });
    it('and at APPLY with ToolForbidden', async () => {
      await expect(
        applyOf(T(c.tool), c.args, c.staffMay ? 'customer' : 'staff')
      ).rejects.toBeInstanceOf(ToolForbidden);
      untouched(c);
    });
    it('a super admin (impersonation) is refused at preview and apply', async () => {
      await expect(previewOf(T(c.tool), c.args, 'super_admin')).rejects.toThrow(/FORBIDDEN/);
      await expect(applyOf(T(c.tool), c.args, 'super_admin')).rejects.toBeInstanceOf(ToolForbidden);
      untouched(c);
    });
    if (c.feature)
      it('plan feature off: refused at preview and, if it flips after the card, at apply', async () => {
        m.featureEnabled.mockResolvedValue(false);
        await expect(previewOf(T(c.tool), c.args)).rejects.toThrow(/feature/);
        m.featureEnabled.mockResolvedValue(true);
        const t = T(c.tool);
        const draft = await previewOf(t, c.args);
        m.featureEnabled.mockResolvedValue(false);
        await expect(t.apply!(ctxOf(), c.args as never, draft)).rejects.toBeInstanceOf(
          ToolForbidden
        );
        untouched(c);
      });
  });
});
