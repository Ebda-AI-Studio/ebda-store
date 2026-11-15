/** Storefront / presentation / AI-job assistant tools (plan 4 E5): domain, redirects, llms.txt, AI sweeps + switch, PWA, QR, branches, three reads. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  EnqueueError: class EnqueueError extends Error {},
  featureEnabled: vi.fn(),
  features: vi.fn(),
  insertAuditLog: vi.fn(),
  domainState: vi.fn(),
  setDomain: vi.fn(),
  listRedirects: vi.fn(),
  deleteRedirect: vi.fn(),
  enqueue: vi.fn(),
  aiEnabled: vi.fn(),
  setAi: vi.fn(),
  setAiCheck: vi.fn(),
  pwaGet: vi.fn(),
  pwaUpdate: vi.fn(),
  qrUpdate: vi.fn(),
  storeRow: {} as Record<string, unknown>,
  loc: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  pages: vi.fn(),
  counts: { products: 3, categories: 2, active: null as unknown },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled, getStoreFeatures: m.features },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: { findUnique: async () => m.storeRow },
    bulkAiJob: { findFirst: async () => m.counts.active },
    product: { count: async () => m.counts.products },
    category: { count: async () => m.counts.categories },
  }),
}));
vi.mock('@api/lib/store-ai-switch', () => ({
  isStoreAiEnabled: m.aiEnabled,
  setStoreAiEnabled: m.setAi,
  assertStoreAiEnabled: m.setAiCheck,
}));
vi.mock('@api/services/store-domain.service', async () => {
  const real = await vi
    .importActual<
      typeof import('@api/services/store-domain.service')
    >('@api/services/store-domain.service')
    .catch(() => null);
  return {
    readStoreDomainState: m.domainState,
    setStoreDomain: m.setDomain,
    fallbackDnsRecords: (d: string) => [{ type: 'CNAME', name: d, value: 'fallback.example' }],
    // the real validator without importing the provider chain
    parseCustomDomain: (raw: string | null) => {
      if (!raw) return null;
      const d = raw
        .trim()
        .toLowerCase()
        .replace(/^www\./, '');
      if (d.endsWith('.ebda.app') || !d.includes('.')) throw new Error('Enter your own domain');
      return d;
    },
    _real: real,
  };
});
vi.mock('@api/services/slug-redirect.service', () => ({
  listSlugRedirects: m.listRedirects,
  deleteSlugRedirect: m.deleteRedirect,
}));
vi.mock('@api/services/bulk-ai-job.service', () => ({
  enqueueBulkAiJob: m.enqueue,
  BulkAiEnqueueError: m.EnqueueError,
}));
vi.mock('@api/services/pwa.service', () => ({
  PWAService: { getSettings: m.pwaGet, updateSettings: m.pwaUpdate },
}));
vi.mock('@api/services/qr.service', () => ({
  readQrSettings: (raw: { qr?: unknown } | null) =>
    (raw?.qr as never) ?? {
      design: {
        style: 'rounded',
        finder: 'rounded',
        frame: 'card',
        fg: '#14110d',
        bg: '#ffffff',
        frameColor: '#b08d57',
        cta: { text: 'امسح', lang: 'ar' },
        logo: false,
      },
    },
}));
vi.mock('@api/services/store.service', () => ({ StoreService: { updateQrSettings: m.qrUpdate } }));
vi.mock('@api/services/locations.service', () => ({ LocationsService: m.loc }));
vi.mock('@api/services/pages.service', () => ({ PagesService: { list: m.pages } }));

import { ToolForbidden, effectivePolicy } from '@ebda/shared/smart-layer';
import { checkAdapterContract, type SmartLayerAdapter } from '@ebda/shared/smart-layer';
import { storeRegistry } from '@api/smart-layer/registry';
import { storefrontTools } from '@api/smart-layer/tools/storefront.tools';
import { applyOf, ctxOf, previewOf, toolNamed } from './helpers/assistant-tool-harness';

const tools = storefrontTools();
const T = (n: string) => toolNamed(tools, n);
const cap = (policy: string, undo: string) => ({ policy, undo }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.aiEnabled.mockResolvedValue(true);
  m.counts.products = 3;
  m.counts.categories = 2;
  m.counts.active = null;
  m.storeRow = {};
});

describe('registry shape', () => {
  it('agrees with the capability registry (policy and undo never looser, capabilities live)', () => {
    const problems = checkAdapterContract({
      registry: () => storeRegistry(),
      tools: () => tools,
    } as unknown as SmartLayerAdapter);
    expect(problems).toEqual([]);
  });
  it('no argument carries a store id; every non-free tool previews and applies', () => {
    for (const t of tools) {
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
      if (t.policy === 'free') expect(t.read).toBeTypeOf('function');
      else expect(t.preview && t.apply).toBeTruthy();
    }
  });
});

describe('reads', () => {
  it('pages_list lists at most 10 pages for a store admin, refuses staff', async () => {
    m.pages.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        slug: `p${i}`,
        title: 'T',
        titleAr: null,
        isPublished: true,
      }))
    );
    const r = (await T('pages_list').read!(ctxOf(), {} as never)) as {
      total: number;
      pages: unknown[];
    };
    expect(r.total).toBe(12);
    expect(r.pages).toHaveLength(10);
    await expect(T('pages_list').read!(ctxOf('staff'), {} as never)).rejects.toThrow(/forbidden/);
  });
  it('shopper and customer-account reads report the switched features', async () => {
    m.features.mockResolvedValue({
      reviews: true,
      coupons: false,
      returns: true,
      loyalty: true,
      customer_wallet: true,
      customer_wallet_checkout: false,
      pwa: true,
    });
    m.storeRow = {
      loyaltyEnabled: true,
      blogEnabled: false,
      locationsEnabled: true,
      pwaEnabled: true,
    };
    const s = (await T('shopper_features_status').read!(ctxOf(), {} as never)) as Record<
      string,
      unknown
    >;
    expect(s).toMatchObject({
      reviews: true,
      coupons: false,
      phoneApp: true,
      blog: false,
      branches: true,
    });
    const c = (await T('customer_account_status').read!(ctxOf(), {} as never)) as Record<
      string,
      unknown
    >;
    expect(c).toMatchObject({
      returns: true,
      loyaltyPoints: true,
      wallet: true,
      walletAtCheckout: false,
    });
  });
});

describe('domain_connect', () => {
  const t = () => T('domain_connect');
  beforeEach(() => {
    m.domainState.mockResolvedValue({
      domain: 'old.com',
      pendingDomain: null,
      domainStatus: 'active',
    });
    m.setDomain.mockResolvedValue({
      claimState: 'pending',
      domain: 'shop.com',
      provider: { getDomain: async () => null },
    });
  });
  it('is confirm-class, shows the DNS record and the before value, restores the old domain', async () => {
    const d = await previewOf(t(), { domain: 'WWW.Shop.com' });
    expect(t().policy).toBe('confirm');
    expect(d.rows[0]).toMatchObject({ before: 'old.com', after: 'shop.com' });
    expect(JSON.stringify(d.rows)).toContain('CNAME shop.com -> fallback.example');
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(effectivePolicy(t(), d, { cap: cap('confirm', 'reversible') }).policy).toBe('confirm');
    expect(t().inverse!(ctxOf(), { domain: 'shop.com' }, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'domain_connect',
      args: { domain: 'old.com' },
    });
  });
  it('applies through setStoreDomain with the assistant audit; staff refused; an Ebda address refused at preview', async () => {
    await applyOf(t(), { domain: 'shop.com' });
    expect(m.setDomain).toHaveBeenCalledWith('s1', 'shop.com');
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    await expect(applyOf(t(), { domain: 'shop.com' }, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
    await expect(previewOf(t(), { domain: 'x.ebda.app' })).rejects.toThrow(/own domain/);
  });
});

describe('slug_redirect_delete', () => {
  const t = () => T('slug_redirect_delete');
  const rows = [
    { id: 'r1', entityType: 'PRODUCT', fromSlug: 'old', toSlug: 'new' },
    { id: 'r2', entityType: 'CATEGORY', fromSlug: 'older', toSlug: 'x' },
  ];
  it('is a flagged irreversible delete listing exactly the matching redirects, no inverse', async () => {
    m.listRedirects.mockResolvedValue({ rows });
    expect(t().deletes).toBe(true);
    expect(t().inverse).toBeUndefined();
    const d = await previewOf(t(), { fromSlug: 'old' });
    expect(d.affectedCount).toBe(1);
    expect(d.rows[0]!.before).toBe('old -> new');
    expect(effectivePolicy(t(), d, { cap: cap('confirm', 'irreversible') }).reasons).toContain(
      'delete'
    );
  });
  it('deletes through the service; no match never reaches run; plan feature and staff refused', async () => {
    m.listRedirects.mockResolvedValue({ rows });
    await applyOf(t(), { fromSlug: 'old' });
    expect(m.deleteRedirect).toHaveBeenCalledWith('s1', 'r1');
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    m.deleteRedirect.mockClear();
    m.listRedirects.mockResolvedValue({ rows: [] });
    await expect(applyOf(t(), { fromSlug: 'nope' })).rejects.toThrow(/no redirect/);
    m.listRedirects.mockResolvedValue({ rows });
    await expect(applyOf(t(), { fromSlug: 'old' }, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    const d = await previewOf(t(), { fromSlug: 'old' });
    m.featureEnabled.mockResolvedValue(false);
    await expect(t().apply!(ctxOf(), { fromSlug: 'old' } as never, d)).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.deleteRedirect).not.toHaveBeenCalled();
  });
});

describe('AI jobs', () => {
  beforeEach(() => m.enqueue.mockResolvedValue({ id: 'job1' }));
  it('ai_bulk_translate: card counts products, enqueues the same job as the route, returns its id, irreversible', async () => {
    const t = T('ai_bulk_translate');
    expect(t.undo).toBe('irreversible');
    expect(t.inverse).toBeUndefined();
    const { draft, applied } = await applyOf(t, { direction: 'to_ar' });
    expect(draft.affectedCount).toBe(3);
    expect(JSON.stringify(draft.rows)).toContain('Estimated AI requests');
    expect(m.enqueue).toHaveBeenCalledWith('s1', 'u1', { kind: 'translate', direction: 'to_ar' });
    expect((applied as { result: unknown }).result).toEqual({ jobId: 'job1' });
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('a 25-product sweep has affectedCount 25; more than 50 products, AI off or a running job never reach run', async () => {
    m.counts.products = 25;
    expect((await previewOf(T('ai_bulk_translate'), { direction: 'to_en' })).affectedCount).toBe(
      25
    );
    m.counts.products = 51;
    await expect(applyOf(T('ai_bulk_translate'), { direction: 'to_en' })).rejects.toThrow(
      /up to 50/
    );
    m.counts.products = 3;
    m.aiEnabled.mockResolvedValue(false);
    await expect(applyOf(T('ai_bulk_seo'), {})).rejects.toThrow(/switched off/);
    m.aiEnabled.mockResolvedValue(true);
    m.counts.active = { id: 'j0' };
    await expect(applyOf(T('ai_bulk_seo'), {})).rejects.toThrow(/already running/);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('llms_txt_generate is confirm-class; staff and a plan without bulk_operations are refused', async () => {
    const t = T('llms_txt_generate');
    expect(t.policy).toBe('confirm');
    await applyOf(t, {});
    expect(m.enqueue).toHaveBeenCalledWith('s1', 'u1', { kind: 'llms_txt' });
    m.enqueue.mockClear();
    await expect(applyOf(t, {}, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    const d = await previewOf(t, {});
    m.featureEnabled.mockResolvedValue(false);
    await expect(t.apply!(ctxOf(), {} as never, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe('ai_switch_set', () => {
  it('previews before/after, flips through the shared writer and undoes to the before value', async () => {
    const t = T('ai_switch_set');
    const { draft } = await applyOf(t, { enabled: false });
    expect(draft.rows[0]).toMatchObject({ before: true, after: false });
    expect(m.setAi).toHaveBeenCalledWith('s1', false);
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    expect(t.inverse!(ctxOf(), { enabled: false }, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'ai_switch_set',
      args: { enabled: true },
    });
    await expect(applyOf(t, { enabled: false }, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
  });
});

describe('pwa_settings_update', () => {
  beforeEach(() =>
    m.pwaGet.mockResolvedValue({
      pwaEnabled: false,
      settings: { appName: 'Old', shortName: 'Old', themeColor: '#000000' },
    })
  );
  it('previews, splits pwaEnabled from settings, and restores the before values', async () => {
    const t = T('pwa_settings_update');
    const args = { pwaEnabled: true, appName: 'نور' };
    const { draft } = await applyOf(t, args);
    expect(draft.rows).toHaveLength(2);
    expect(m.pwaUpdate).toHaveBeenCalledWith('s1', {
      pwaEnabled: true,
      settings: { appName: 'نور' },
    });
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'pwa_settings_update',
      args: { pwaEnabled: false, appName: 'Old' },
    });
  });
  it('rejects a bad colour or a long short name; staff and a missing plan feature are refused', async () => {
    const t = T('pwa_settings_update');
    expect(t.args.safeParse({ themeColor: 'red' }).success).toBe(false);
    expect(t.args.safeParse({ shortName: 'x'.repeat(13) }).success).toBe(false);
    await expect(applyOf(t, { appName: 'a' }, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    const d = await previewOf(t, { appName: 'a' });
    m.featureEnabled.mockResolvedValue(false);
    await expect(t.apply!(ctxOf(), { appName: 'a' } as never, d)).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.pwaUpdate).not.toHaveBeenCalled();
  });
});

describe('qr_design_update', () => {
  it('merges onto the current design, saves through StoreService and restores the before values', async () => {
    const t = T('qr_design_update');
    const args = { fg: '#000000', frame: 'badge' };
    const { draft } = await applyOf(t, args);
    expect(m.qrUpdate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        design: expect.objectContaining({ fg: '#000000', frame: 'badge', bg: '#ffffff' }),
      })
    );
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'qr_design_update',
      args: { fg: '#14110d', frame: 'card' },
    });
  });
  it('refuses a design that would not scan (low contrast) at preview, and staff at apply', async () => {
    await expect(previewOf(T('qr_design_update'), { fg: '#fefefe' })).rejects.toThrow();
    await expect(applyOf(T('qr_design_update'), { logo: true }, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.qrUpdate).not.toHaveBeenCalled();
  });
});

describe('branches', () => {
  const row = {
    id: 'l1',
    name: 'Maadi',
    country: 'Egypt',
    address: 'St 9',
    hours: '9-5',
    updatedAt: 1,
  };
  beforeEach(() => m.loc.list.mockResolvedValue([row]));
  it('location_add creates through the service; its inverse is the confirm-class location_delete of the new id', async () => {
    m.loc.create.mockResolvedValue({ id: 'l2' });
    const t = T('location_add');
    const { draft, applied } = await applyOf(t, {
      name: 'Zayed',
      country: 'Egypt',
      address: 'Hub',
    });
    expect(m.loc.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ name: 'Zayed', isPublished: true })
    );
    expect(t.inverse!(ctxOf(), { name: 'Zayed' } as never, draft, applied)).toEqual({
      tool: 'location_delete',
      args: { locationId: 'l2' },
    });
    expect(T('location_delete').policy).toBe('confirm');
  });
  it('location_update restores the before values and a foreign id never reaches run', async () => {
    const t = T('location_update');
    m.loc.update.mockResolvedValue({ id: 'l1' });
    const args = { locationId: 'l1', hours: '10-6' };
    const { draft } = await applyOf(t, args);
    expect(draft.rows[0]).toMatchObject({ before: '9-5', after: '10-6' });
    expect(m.loc.update).toHaveBeenCalledWith('s1', 'l1', { hours: '10-6' });
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'location_update',
      args: { locationId: 'l1', hours: '9-5' },
    });
    m.loc.update.mockClear();
    await expect(applyOf(t, { locationId: 'other', hours: 'x' })).rejects.toThrow(/not found/);
    expect(m.loc.update).not.toHaveBeenCalled();
  });
  it('location_delete is a flagged irreversible delete naming the branch, no inverse', async () => {
    const t = T('location_delete');
    expect(t.deletes).toBe(true);
    expect(t.inverse).toBeUndefined();
    const d = await previewOf(t, { locationId: 'l1' });
    expect(d.rows[0]!.before).toContain('Maadi');
    expect(effectivePolicy(t, d, { cap: cap('preview', 'reversible') }).reasons).toEqual(
      expect.arrayContaining(['delete', 'irreversible'])
    );
    m.loc.remove.mockResolvedValue(true);
    await applyOf(t, { locationId: 'l1' });
    expect(m.loc.remove).toHaveBeenCalledWith('s1', 'l1');
    await expect(applyOf(t, { locationId: 'l1' }, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
  });
});
