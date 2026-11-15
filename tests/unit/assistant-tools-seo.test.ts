/** SEO assistant tools (plan 4 B6): store search appearance and the answer-engine description, both through StoreService.updateSeo behind the `seo` plan feature. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  updateSeo: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: async () => m.row } }),
}));
vi.mock('@api/services/store.service', () => ({ StoreService: { updateSeo: m.updateSeo } }));

import { MerchantForbidden } from '@api/mcp/run-as-merchant';
import { storeRegistry } from '@api/smart-layer/registry';
import { applyThenUndo } from './helpers/undo-roundtrip';
import { seoTools } from '@api/smart-layer/tools/seo.tools';

const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (n: string): ToolSpec => seoTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

const cases = [
  {
    name: 'seo_meta_update',
    row: { metaTitle: 'Old', settings: { hideFromSearchEngines: false } },
    args: { metaTitle: 'عنوان جديد', hideFromSearchEngines: true },
    restore: { metaTitle: 'Old', hideFromSearchEngines: false },
    hostile: { metaTitle: '', metaTitleAr: null, settings: null },
    all: {
      metaTitle: 'a',
      metaTitleAr: 'a',
      metaDescription: 'a',
      metaDescriptionAr: 'a',
      twitterHandle: 'a',
      hideFromSearchEngines: false,
    },
  },
  {
    name: 'answer_engine_settings',
    row: { metaDescriptionAeo: 'old' },
    args: { metaDescriptionAeo: 'We sell gold jewellery in Cairo.' },
    restore: { metaDescriptionAeo: 'old' },
    hostile: { metaDescriptionAeo: '', metaDescriptionAeoAr: null },
    all: { metaDescriptionAeo: 'a', metaDescriptionAeoAr: 'a' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
});

describe('seo tools', () => {
  it('are preview + reversible and take no store id', () => {
    expect(
      seoTools()
        .map(t => t.name)
        .sort()
    ).toEqual(['answer_engine_settings', 'seo_meta_update']);
    for (const t of seoTools()) {
      expect(t.policy).toBe('preview');
      expect(t.undo).toBe('reversible');
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('preview lists before/after, an etag and the restore values', async () => {
        m.row = c.row;
        const d = await tool(c.name).preview!(ctx(), parse(c.name, c.args));
        expect(d.rows.length).toBe(Object.keys(c.args).length);
        expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
        expect((d.payload as { restore: unknown }).restore).toEqual(c.restore);
      });

      it('apply is audited as the assistant and calls updateSeo', async () => {
        m.row = c.row;
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const d = await t.preview!(ctx(), args);
        await t.apply!(ctx(), args, d);
        expect(m.updateSeo).toHaveBeenCalledWith('S1', c.args);
        expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
          actor: 'assistant',
          tool: c.name,
        });
      });

      it('staff gets ToolForbidden, and a plan without the seo feature too', async () => {
        m.row = c.row;
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const d = await t.preview!(ctx(), args);
        await expect(t.apply!(ctx('staff'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        m.featureEnabled.mockResolvedValue(false);
        await expect(t.apply!(ctx(), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        expect(m.updateSeo).not.toHaveBeenCalled();
      });

      it('staff is refused at PREVIEW, the card is never built (mutation: delete the roles gate)', async () => {
        m.row = c.row;
        await expect(
          tool(c.name).preview!(ctx('staff'), parse(c.name, c.args))
        ).rejects.toBeInstanceOf(MerchantForbidden);
        await expect(
          tool(c.name).preview!(ctx('super_admin'), parse(c.name, c.args))
        ).rejects.toBeInstanceOf(MerchantForbidden);
      });

      it('the seo plan feature off is refused at PREVIEW too (mutation: delete the feature gate)', async () => {
        m.row = c.row;
        m.featureEnabled.mockResolvedValue(false);
        await expect(tool(c.name).preview!(ctx(), parse(c.name, c.args))).rejects.toBeInstanceOf(
          MerchantForbidden
        );
      });

      it('a stored row of nulls and empty strings still previews and its undo passes validation', async () => {
        m.row = c.hostile;
        const t = tool(c.name);
        const args = parse(c.name, c.all);
        const d = await t.preview!(ctx(), args);
        const inv = t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' });
        expect(t.args.safeParse(inv!.args).success).toBe(true);
      });

      it('engine round trip: apply then undo ends undone', async () => {
        m.row = c.row;
        const r = await applyThenUndo(seoTools(), tool(c.name), c.args);
        expect(r.applied).toBe('applied');
        expect(r.undo).toBe('undone');
      });

      it('the inverse restores the before values', async () => {
        m.row = c.row;
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const d = await t.preview!(ctx(), args);
        expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
          tool: c.name,
          args: c.restore,
        });
      });
    });
  }

  it('does not accept an image, a verification token or the sender prefix', () => {
    for (const bad of ['ogImage', 'googleSiteVerification', 'emailSenderLocalPart', 'slug']) {
      expect(tool('seo_meta_update').args.safeParse({ [bad]: 'x' }).success).toBe(false);
    }
    expect(
      tool('answer_engine_settings').args.safeParse({ metaDescriptionAeo: 'x'.repeat(401) }).success
    ).toBe(false);
  });

  it('hiding the store from search engines escalates to confirm and says so; other changes stay a preview', async () => {
    const t = tool('seo_meta_update');
    const cap = storeRegistry().caps.get('store.seo')!;
    m.row = { metaTitle: 'x', settings: { hideFromSearchEngines: false } };
    const hide = await t.preview!(ctx(), parse('seo_meta_update', { hideFromSearchEngines: true }));
    expect(hide.touchesCheckout).toBe(true);
    expect(hide.summary.en).toMatch(/disappears from Google/);
    expect(effectivePolicy(t, hide, { cap }).policy).toBe('confirm');
    const title = await t.preview!(ctx(), parse('seo_meta_update', { metaTitle: 'y' }));
    expect(effectivePolicy(t, title, { cap }).policy).toBe('preview');
    // turning it back on (visible again) is not escalated
    m.row = { settings: { hideFromSearchEngines: true } };
    const show = await t.preview!(
      ctx(),
      parse('seo_meta_update', { hideFromSearchEngines: false })
    );
    expect(effectivePolicy(t, show, { cap }).policy).toBe('preview');
  });
});
