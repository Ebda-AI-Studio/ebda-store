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
import { applyThenUndo } from './helpers/undo-roundtrip';

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
    expect(d.rows.find(r => r.label.en === 'Verified domain')).toMatchObject({
      before: 'old.com',
      after: 'old.com',
    });
    expect(d.rows.find(r => r.label.en === 'Pending claim')).toMatchObject({
      before: null,
      after: 'shop.com',
    });
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
    expect(t().args.safeParse({ domain: null }).success).toBe(false); // disconnecting is its own tool
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
    m.loc.list.mockResolvedValue([row, { ...row, id: 'l2' }]); // the new row exists once created (the kit reads the undo tool's state on it)
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

// ---- fix round for PR 803 ----------------------------------------------------------------------------------------------------------------------
describe('domain_disconnect (finding 2)', () => {
  const t = () => T('domain_disconnect');
  beforeEach(() => {
    m.domainState.mockResolvedValue({
      domain: 'old.com',
      pendingDomain: 'next.com',
      domainStatus: 'active',
    });
    m.setDomain.mockResolvedValue({ claimState: null, domain: null, provider: {} });
  });
  it('is confirm-class, irreversible, has no inverse, and the card says the store goes offline and DNS must be redone', async () => {
    expect(t().policy).toBe('confirm');
    expect(t().undo).toBe('irreversible');
    expect(t().inverse).toBeUndefined();
    const d = await previewOf(t(), {});
    const text = JSON.stringify([d.summary, d.rows]);
    expect(text).toContain('old.com');
    expect(text).toContain('next.com');
    expect(d.summary.en).toMatch(/offline/i);
    expect(d.summary.en).toMatch(/verify DNS again/i);
    expect(d.summary.ar).toMatch(/أوفلاين|مش هيفتح/);
    expect(effectivePolicy(t(), d, { cap: cap('confirm', 'reversible') }).reasons).toContain(
      'irreversible'
    );
  });
  it('disconnects through setStoreDomain(null) with the assistant audit; nothing connected never reaches run', async () => {
    await applyOf(t(), {});
    expect(m.setDomain).toHaveBeenCalledWith('s1', null);
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    m.setDomain.mockClear();
    m.domainState.mockResolvedValue({ domain: null, pendingDomain: null, domainStatus: null });
    await expect(applyOf(t(), {})).rejects.toThrow(/no custom domain/);
    expect(m.setDomain).not.toHaveBeenCalled();
  });
});

describe('domain_connect details (finding 3)', () => {
  it('shows a pending claim next to the verified domain', async () => {
    m.domainState.mockResolvedValue({
      domain: 'old.com',
      pendingDomain: 'half.com',
      domainStatus: 'active',
    });
    const d = await previewOf(T('domain_connect'), { domain: 'new.com' });
    expect(d.rows.find(r => r.label.en === 'Verified domain')).toMatchObject({ before: 'old.com' });
    expect(d.rows.find(r => r.label.en === 'Pending claim')).toMatchObject({
      before: 'half.com',
      after: 'new.com',
    });
  });
  it('undo of a first connect is a confirm-class disconnect card, undo of a replace re-saves the old domain', async () => {
    m.domainState.mockResolvedValue({ domain: null, pendingDomain: null, domainStatus: null });
    m.setDomain.mockImplementation(async () => {
      // after the claim the store holds a pending domain (what the disconnect card will read)
      m.domainState.mockResolvedValue({
        domain: null,
        pendingDomain: 'shop.com',
        domainStatus: 'pending',
      });
      return {
        claimState: 'pending',
        domain: 'shop.com',
        provider: { getDomain: async () => null },
      };
    });
    const first = await applyThenUndo(tools, T('domain_connect'), { domain: 'shop.com' });
    expect(first.applied).toBe('applied');
    expect(first.undo).toBe('needs_confirm');
    m.domainState.mockResolvedValue({
      domain: 'old.com',
      pendingDomain: null,
      domainStatus: 'active',
    });
    const second = await applyThenUndo(tools, T('domain_connect'), { domain: 'shop.com' });
    expect(['undone', 'needs_confirm']).toContain(second.undo);
  });
});

describe('slug_redirect_delete exact lookup (finding 3)', () => {
  it('pages past the first 500 matches until the exact slug is found', async () => {
    const filler = Array.from({ length: 3 }, (_, i) => ({
      id: `f${i}`,
      entityType: 'PRODUCT',
      fromSlug: `old-${i}`,
      toSlug: 'x',
    }));
    m.listRedirects
      .mockResolvedValueOnce({ rows: filler, nextCursor: 'f2' })
      .mockResolvedValueOnce({
        rows: [{ id: 'hit', entityType: 'PRODUCT', fromSlug: 'old', toSlug: 'new' }],
        nextCursor: null,
      });
    const d = await previewOf(T('slug_redirect_delete'), { fromSlug: 'old' });
    expect(d.affectedCount).toBe(1);
    expect(m.listRedirects.mock.calls[1]![1]).toMatchObject({ cursor: 'f2' });
  });
});

describe('only one AI job at a time (finding 3)', () => {
  it('any running job refuses a new one at preview AND at apply', async () => {
    const t = T('ai_bulk_seo');
    const draft = await previewOf(t, {}); // none running at preview
    m.counts.active = { id: 'other-kind-job' };
    await expect(previewOf(t, {})).rejects.toThrow(/already running/);
    await expect(t.apply!(ctxOf(), {} as never, draft)).rejects.toThrow(/already running/);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe('location_add undo round trip (finding 3)', () => {
  it('undoes to a confirm-class delete card', async () => {
    const created = { id: 'l9', name: 'Z', country: 'Egypt', address: 'Hub', updatedAt: 1 };
    m.loc.create.mockResolvedValue(created);
    m.loc.list.mockResolvedValue([created]);
    const r = await applyThenUndo(tools, T('location_add'), {
      name: 'Z',
      country: 'Egypt',
      address: 'Hub',
    });
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('needs_confirm');
  });
});

describe('update tools: undo args pass their own validation', () => {
  it('location_update, pwa_settings_update, qr_design_update, ai_switch_set all come back undone', async () => {
    m.loc.list.mockResolvedValue([
      { id: 'l1', name: 'M', country: 'Egypt', address: 'A', hours: '9-5', updatedAt: 1 },
    ]);
    m.loc.update.mockResolvedValue({ id: 'l1' });
    m.pwaGet.mockResolvedValue({ pwaEnabled: false, settings: { appName: 'Old' } });
    for (const [name, args] of [
      ['location_update', { locationId: 'l1', hours: '10-6' }],
      ['pwa_settings_update', { pwaEnabled: true, appName: 'New' }],
      ['qr_design_update', { frame: 'badge', ctaText: 'امسح' }],
      ['ai_switch_set', { enabled: false }],
    ] as const) {
      const r = await applyThenUndo(tools, T(name), args);
      expect(r, name).toMatchObject({ applied: 'applied', undo: 'undone' });
    }
  });
});

// Every tool of the slice: the role gate at preview and at apply, and the plan-feature gate (finding 4).
const GATED: Array<[string, unknown, string | undefined]> = [
  ['domain_connect', { domain: 'shop.com' }, undefined],
  ['domain_disconnect', {}, undefined],
  ['slug_redirect_delete', { fromSlug: 'old' }, 'seo'],
  ['llms_txt_generate', {}, 'bulk_operations'],
  ['ai_bulk_translate', { direction: 'to_ar' }, 'bulk_operations'],
  ['ai_bulk_seo', {}, 'bulk_operations'],
  ['ai_switch_set', { enabled: false }, undefined],
  ['pwa_settings_update', { appName: 'a' }, 'pwa'],
  ['qr_design_update', { logo: true }, 'inventory.barcode'],
  ['location_add', { name: 'n', country: 'Egypt', address: 'a' }, undefined],
  ['location_update', { locationId: 'l1', hours: 'x' }, undefined],
  ['location_delete', { locationId: 'l1' }, undefined],
];
describe.each(GATED)('gates of %s', (name, args, feature) => {
  beforeEach(() => {
    m.domainState.mockResolvedValue({
      domain: 'old.com',
      pendingDomain: null,
      domainStatus: 'active',
    });
    m.listRedirects.mockResolvedValue({
      rows: [{ id: 'r1', entityType: 'PRODUCT', fromSlug: 'old', toSlug: 'new' }],
    });
    m.loc.list.mockResolvedValue([
      { id: 'l1', name: 'M', country: 'Egypt', address: 'A', hours: '9-5', updatedAt: 1 },
    ]);
    m.pwaGet.mockResolvedValue({ pwaEnabled: false, settings: {} });
    m.enqueue.mockResolvedValue({ id: 'j' });
    m.setDomain.mockResolvedValue({
      claimState: 'pending',
      domain: 'shop.com',
      provider: { getDomain: async () => null },
    });
    m.loc.create.mockResolvedValue({ id: 'n1' });
    m.loc.update.mockResolvedValue({ id: 'l1' });
    m.loc.remove.mockResolvedValue(true);
  });
  const sideEffects = () =>
    [
      m.setDomain,
      m.deleteRedirect,
      m.enqueue,
      m.setAi,
      m.pwaUpdate,
      m.qrUpdate,
      m.loc.create,
      m.loc.update,
      m.loc.remove,
    ].some(f => f.mock.calls.length > 0);
  it('a staff member never gets a card (preview refused)', async () => {
    await expect(previewOf(T(name), args, 'staff')).rejects.toThrow(/FORBIDDEN/);
  });
  it('a staff member pressing apply gets ToolForbidden and nothing runs', async () => {
    const d = await previewOf(T(name), args);
    await expect(T(name).apply!(ctxOf('staff'), args as never, d)).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(sideEffects()).toBe(false);
  });
  if (feature)
    it(`the ${feature} plan feature is required at preview and at apply`, async () => {
      const d = await previewOf(T(name), args);
      m.featureEnabled.mockImplementation(async (_s: string, k: string) => k !== feature);
      await expect(previewOf(T(name), args)).rejects.toThrow(/feature/);
      await expect(T(name).apply!(ctxOf(), args as never, d)).rejects.toBeInstanceOf(ToolForbidden);
      expect(m.featureEnabled).toHaveBeenCalledWith('s1', feature);
      expect(sideEffects()).toBe(false);
    });
});

describe('reads refuse staff where the route does', () => {
  it('pages_list is store_admin only', async () => {
    m.pages.mockResolvedValue([]);
    await expect(T('pages_list').read!(ctxOf('staff'), {} as never)).rejects.toThrow(/forbidden/);
  });
});
