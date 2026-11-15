/** Store settings assistant tools (plan 4 B6): preview card, apply through runAsMerchant, role/feature gates, inverse, and what is never reachable. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ToolForbidden, type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  svc: {
    updateBrandingBundle: vi.fn(),
    updateAnnouncementBar: vi.fn(),
    update: vi.fn(),
    applyLook: vi.fn(),
    updateFloatingWidget: vi.fn(),
    updateSeo: vi.fn(),
  },
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
vi.mock('@api/services/store.service', () => ({ StoreService: m.svc }));

import { storeSettingsTools } from '@api/smart-layer/tools/store-settings.tools';

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
const tool = (n: string): ToolSpec => storeSettingsTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

const cases: Array<{
  name: string;
  row: Record<string, unknown>;
  args: Record<string, unknown>;
  svc: keyof typeof m.svc;
  restore: Record<string, unknown>;
  edited?: Record<string, unknown>;
}> = [
  {
    name: 'store_settings_update',
    row: { phone: '010', socialLinks: { instagram: 'https://i.com/a' }, name: 'Old' },
    args: { phone: '011', instagram: 'https://i.com/b', facebook: null },
    svc: 'updateBrandingBundle',
    restore: { phone: '010', instagram: 'https://i.com/a', facebook: null },
  },
  {
    name: 'branding_update',
    row: { theme: { primaryColor: '#111111' } },
    args: { primaryColor: '#B08D57', accentColor: null },
    svc: 'updateBrandingBundle',
    restore: { primaryColor: '#111111', accentColor: null },
  },
  {
    name: 'announcement_set',
    row: { announcementBar: { text: 'old', enabled: false } },
    args: { text: 'خصم العيد', enabled: true },
    svc: 'updateAnnouncementBar',
    restore: { text: 'old', enabled: false },
  },
  {
    name: 'hero_set',
    row: { heroTitle: 'A' },
    args: { heroTitle: 'B', heroCtaLink: '/products' },
    svc: 'update',
    restore: { heroTitle: 'A', heroCtaLink: null },
  },
  {
    name: 'menu_update',
    row: { settings: { navMenu: [{ label: 'Shop', href: '/products' }] } },
    args: { navMenu: [{ label: 'About', href: '/about' }] },
    svc: 'update',
    restore: { navMenu: [{ label: 'Shop', href: '/products' }] },
  },
  {
    name: 'look_update',
    row: { look: 'qamar.atelier', template: 'qamar' },
    args: { lookId: 'qamar.atelier' },
    svc: 'applyLook',
    restore: { look: 'qamar.atelier' },
  },
  {
    name: 'whatsapp_buttons_set',
    row: { settings: { floatingWidget: { enabled: false, buttons: [] } } },
    args: { enabled: true, whatsappPhone: '01012345678' },
    svc: 'updateFloatingWidget',
    restore: { enabled: false, whatsappPhone: null },
    edited: { settings: { floatingWidget: { enabled: true, buttons: [] } } },
  },
  {
    name: 'store_language_set',
    row: { settings: { defaultLanguage: 'en' } },
    args: { defaultLanguage: 'ar' },
    svc: 'update',
    restore: { defaultLanguage: 'en' },
    edited: { settings: { defaultLanguage: 'ar' } },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
});

describe('store settings tools', () => {
  it('exposes the planned tools, all preview-or-stricter and reversible, none taking a store id', () => {
    const ts = storeSettingsTools();
    expect(ts.map(t => t.name).sort()).toEqual(cases.map(c => c.name).sort());
    for (const t of ts) {
      expect(t.policy).toBe('preview');
      expect(t.undo).toBe('reversible');
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('preview shows before/after rows, an etag and the BEFORE values', async () => {
        m.row = c.row;
        const args = parse(c.name, c.args);
        const d = await tool(c.name).preview!(ctx(), args);
        expect(d.rows.length).toBeGreaterThan(0);
        expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
        expect(d.affectedCount).toBe(1);
        expect((d.payload as { restore: unknown }).restore).toEqual(c.restore);
      });

      it('a hand edit in between changes the etag', async () => {
        m.row = c.row;
        const args = parse(c.name, c.args);
        const a = await tool(c.name).preview!(ctx(), args);
        m.row = { ...c.row, [Object.keys(c.row)[0]]: 'edited-by-hand', ...c.edited };
        const b = await tool(c.name).preview!(ctx(), args);
        expect(b.etag).not.toBe(a.etag);
      });

      it('apply goes through runAsMerchant as the assistant and calls the route service', async () => {
        m.row = c.row;
        const args = parse(c.name, c.args);
        const t = tool(c.name);
        const d = await t.preview!(ctx(), args);
        const r = await t.apply!(ctx(), args, d);
        expect(r.ok).toBe(true);
        expect(m.svc[c.svc]).toHaveBeenCalledTimes(1);
        expect(m.svc[c.svc].mock.calls[0][0]).toBe('S1');
        const intent = m.insertAuditLog.mock.calls[0][0];
        expect(intent.details).toMatchObject({ actor: 'assistant', phase: 'intent', tool: c.name });
      });

      it('staff (no route access) gets ToolForbidden and nothing runs', async () => {
        m.row = c.row;
        const args = parse(c.name, c.args);
        const t = tool(c.name);
        const d = await t.preview!(ctx(), args);
        await expect(t.apply!(ctx('staff'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        expect(m.svc[c.svc]).not.toHaveBeenCalled();
        expect(m.insertAuditLog).not.toHaveBeenCalled();
      });

      it('the inverse restores the before values through the same tool', async () => {
        m.row = c.row;
        const args = parse(c.name, c.args);
        const t = tool(c.name);
        const d = await t.preview!(ctx(), args);
        const inv = t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' });
        expect(inv).toEqual({
          tool: c.name,
          args: c.name === 'look_update' ? { lookId: 'qamar.atelier' } : c.restore,
        });
        // and the restore is itself a valid call of the tool
        expect(() => t.args.parse(inv!.args)).not.toThrow();
      });
    });
  }

  it('what the screen does not own is not accepted (slug, currency, plan, status, domain, settings, secrets)', () => {
    const t = tool('store_settings_update');
    for (const bad of [
      'slug',
      'currency',
      'plan',
      'status',
      'domain',
      'settings',
      'password',
      'apiKey',
      'mcpWriteEnabled',
      'assistantMode',
    ]) {
      expect(t.args.safeParse({ [bad]: 'x' }).success).toBe(false);
    }
    expect(t.args.safeParse({}).success).toBe(false);
  });

  it('unsafe links and bad numbers are refused at the edge', () => {
    expect(
      tool('store_settings_update').args.safeParse({ instagram: 'javascript:alert(1)' }).success
    ).toBe(false);
    expect(tool('store_settings_update').args.safeParse({ whatsapp: '123' }).success).toBe(false);
    expect(tool('hero_set').args.safeParse({ heroCtaLink: 'data:text/html,x' }).success).toBe(
      false
    );
    expect(
      tool('menu_update').args.safeParse({ navMenu: [{ label: 'x', href: 'javascript:1' }] })
        .success
    ).toBe(false);
    expect(tool('announcement_set').args.safeParse({ link: 'vbscript:1' }).success).toBe(false);
  });

  it('whatsapp is normalised to E.164 and social links split into set / remove', async () => {
    m.row = { socialLinks: { tiktok: 'https://t.com/x' } };
    const t = tool('store_settings_update');
    const args = parse('store_settings_update', {
      whatsapp: '01012345678',
      tiktok: null,
      youtube: 'https://y.com/c',
    });
    await t.apply!(ctx(), args, await t.preview!(ctx(), args));
    expect(m.svc.updateBrandingBundle.mock.calls[0][1]).toEqual({
      contact: { whatsapp: '+201012345678' },
      social: { set: { youtube: 'https://y.com/c' }, remove: ['tiktok'] },
    });
  });

  it('a look change is a checkout-touching preview and an unavailable look is refused', async () => {
    m.row = { look: null, template: 'qamar' };
    const args = parse('look_update', { lookId: 'qamar.atelier' });
    const d = await tool('look_update').preview!(ctx(), args);
    expect(d.touchesCheckout).toBe(true);
    await expect(
      tool('look_update').preview!(ctx(), parse('look_update', { lookId: 'nope.nope' }))
    ).rejects.toThrow();
    // a bare-template store has nothing to switch back to
    expect(tool('look_update').inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toBeNull();
  });

  it('changing the language touches checkout', async () => {
    m.row = { settings: {} };
    const d = await tool('store_language_set').preview!(
      ctx(),
      parse('store_language_set', { defaultLanguage: 'ar' })
    );
    expect(d.touchesCheckout).toBe(true);
    expect((d.payload as { restore: unknown }).restore).toEqual({ defaultLanguage: 'en' });
  });

  it('the menu keeps the footer legal row (bottomBar) when a column changes', async () => {
    m.row = { settings: { footerLinks: { bottomBar: { x: 1 }, shop: [] } } };
    const t = tool('menu_update');
    const args = parse('menu_update', { footerSupport: [{ name: 'FAQ', href: '/faq' }] });
    await t.apply!(ctx(), args, await t.preview!(ctx(), args));
    expect(m.svc.update.mock.calls[0][1]).toEqual({
      settings: {
        footerLinks: { bottomBar: { x: 1 }, shop: [], support: [{ name: 'FAQ', href: '/faq' }] },
      },
    });
  });

  it('the WhatsApp button keeps the other buttons of the widget and needs the plan feature', async () => {
    m.row = {
      settings: { floatingWidget: { enabled: true, buttons: [{ id: 'i', kind: 'instagram' }] } },
    };
    const t = tool('whatsapp_buttons_set');
    const args = parse('whatsapp_buttons_set', {
      whatsappPhone: '01012345678',
      whatsappMessage: 'hi',
    });
    const d = await t.preview!(ctx(), args);
    await t.apply!(ctx(), args, d);
    const sent = m.svc.updateFloatingWidget.mock.calls[0][1] as {
      buttons: Array<Record<string, unknown>>;
    };
    expect(sent.buttons).toEqual([
      { id: 'i', kind: 'instagram' },
      { id: 'wa-1', kind: 'whatsapp', whatsappPhone: '201012345678', whatsappMessage: 'hi' },
    ]);
    m.featureEnabled.mockResolvedValue(false);
    await expect(t.apply!(ctx(), args, d)).rejects.toBeInstanceOf(ToolForbidden);
  });
});
