import { describe, it, expect } from 'vitest';
import {
  canSeeEntry,
  entryHref,
  mergeRegistryIntoPalette,
  registryPaletteItems,
  searchRegistry,
  type SearchContext,
} from '../settings-search';
import index from '../settings-search-index.generated.json';
import type { IndexEntry } from '../settings-index-build';

const all = (): SearchContext => ({
  role: 'store_admin',
  isFeatureEnabled: () => true,
  featuresLoading: false,
});
const ids = (q: string, ctx: SearchContext = all(), limit = 12) =>
  searchRegistry(q, ctx, limit).map(h => h.entry.id);

describe('admin settings search: the requested queries, Arabic and English', () => {
  it.each([
    ['أيام بدون توصيل', 'delivery.off-days', 1],
    ['ايام بدون توصيل', 'delivery.off-days', 1], // no hamza: the Arabic normaliser
    ['days with no delivery', 'delivery.off-days', 1],
    ['holiday', 'delivery.off-days', 3],
    ['change logo', 'branding.logo', 2],
    ['تغيير الشعار', 'branding.logo', 2],
    ['logo', 'branding.logo', 3],
    ['دليل المقاسات', 'page:/size-charts', 1],
    ['size guide', 'page:/size-charts', 2],
    ['الشحن', 'page:/shipping', 3],
    ['shipping', 'page:/shipping', 3],
    ['الضريبة', 'page:/tax', 3],
    ['اللغة الافتراضية', 'language.default', 2],
    ['cash on delivery fee', 'payment.cod-fee', 1],
    ['free shipping', 'shipping.area-rates', 2],
    ['page title google', 'seo.meta-title', 2],
    ['SEO', 'page:/seo', 1],
    ['seo', 'page:/seo', 1],
    ['سيو', 'page:/seo', 1],
    ['محركات البحث', 'page:/seo', 2],
  ])('%s -> %s within the top %i', (q, id, top) => {
    expect(ids(q).slice(0, top)).toContain(id);
  });

  it('"delivery days" finds both the delivery-time and the no-delivery-days controls', () => {
    const top = ids('delivery days').slice(0, 4);
    expect(top).toContain('delivery.days');
    expect(top).toContain('delivery.off-days');
  });

  it('an Arabic definite article is optional: "الشحن" and "شحن" find the same page', () => {
    expect(ids('شحن').slice(0, 3)).toContain('page:/shipping');
    expect(ids('الشحن').slice(0, 3)).toContain('page:/shipping');
  });

  it('every word must match, and a blank query matches nothing', () => {
    expect(ids('logo zzzzqqq')).toEqual([]);
    expect(ids('   ')).toEqual([]);
    expect(ids('')).toEqual([]);
  });

  it('own-label hits rank before page-name hits, and pages before the settings on them', () => {
    const hits = searchRegistry('shipping', all(), 50);
    const ranks = hits.map(h => h.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const firstSetting = hits.findIndex(h => h.entry.kind === 'setting' && h.rank === 0);
    const pageIdx = hits.findIndex(h => h.entry.id === 'page:/shipping');
    if (firstSetting !== -1) expect(pageIdx).toBeLessThan(firstSetting);
  });
});

describe('admin settings search: who may see what', () => {
  it('staff never see owner-only pages or settings (billing, branding, delivery, finance)', () => {
    const staff: SearchContext = { ...all(), role: 'staff' };
    expect(ids('billing', staff)).toEqual([]);
    expect(ids('logo', staff)).not.toContain('branding.logo');
    expect(ids('delivery', staff)).not.toContain('delivery.off-days');
    expect(ids('journal', staff)).toEqual([]);
    expect(ids('orders', staff)).toContain('page:/orders');
    expect(ids('floating', staff)).toContain('floating-widget.show'); // a staff-level page
  });

  it('only a super admin sees platform-only pages', () => {
    expect(ids('feature flags').includes('page:/features')).toBe(false);
    expect(ids('feature flags', { ...all(), role: 'super_admin' })).toContain('page:/features');
  });

  it('an unknown role sees nothing', () => {
    expect(ids('logo', { ...all(), role: 'customer' })).toEqual([]);
    expect(ids('logo', { ...all(), role: undefined })).toEqual([]);
  });

  it('a feature-keyed entry is hidden while features load and when the feature is off', () => {
    const off: SearchContext = { ...all(), isFeatureEnabled: k => k !== 'agent_checkout' };
    expect(ids('mcp', all())).toContain('page:/agent-key');
    expect(ids('mcp', off)).not.toContain('page:/agent-key');
    expect(ids('واتساب', off)).toContain('branding.whatsapp-buttons'); // not feature-gated
    const loading: SearchContext = { ...all(), featuresLoading: true };
    expect(ids('mcp', loading)).not.toContain('page:/agent-key');
    expect(ids('shipping carriers', { ...all(), isFeatureEnabled: () => false })).not.toContain(
      'page:/shipping-carriers'
    );
    expect(ids('shipping carriers')).toContain('page:/shipping-carriers');
  });

  it('canSeeEntry follows the same rule for every index row (no row visible to staff that is owner-only)', () => {
    const staff: SearchContext = { ...all(), role: 'staff' };
    for (const e of index as IndexEntry[]) {
      if (e.access !== 'staff') expect(canSeeEntry(e, staff), e.id).toBe(false);
    }
  });
});

describe('admin settings search: links and palette items', () => {
  const byId = (id: string) => (index as IndexEntry[]).find(e => e.id === id)!;

  it('a page links to its route; a setting adds its tab and ?setting=', () => {
    expect(entryHref('s1', byId('page:/delivery'))).toBe('/stores/s1/delivery');
    expect(entryHref('s1', byId('page:/'))).toBe('/stores/s1');
    expect(entryHref('s1', byId('delivery.off-days'))).toBe(
      '/stores/s1/delivery?setting=delivery.off-days'
    );
    expect(entryHref('s1', byId('branding.logo-size'))).toBe(
      '/stores/s1/branding?tab=theme&setting=branding.logo-size'
    );
  });

  it('palette items carry the label in the UI language and BOTH languages in the keywords', () => {
    const ar = registryPaletteItems('s1', all(), 'ar').find(i =>
      i.href.includes('delivery.off-days')
    )!;
    const en = registryPaletteItems('s1', all(), 'en').find(i =>
      i.href.includes('delivery.off-days')
    )!;
    expect(ar.name).toBe('أيام بدون توصيل');
    expect(en.name).toBe('Days with no delivery');
    expect(ar.keywords).toContain('Days with no delivery');
    expect(en.keywords).toContain('أيام بدون توصيل');
    expect(ar.kind).toBe('setting');
    expect(ar.group).toBeTruthy();
  });

  it('merging lends a registry page its synonyms to the palette item that already lists the page', () => {
    const existing = [
      { name: 'الشحن', href: '/stores/s1/shipping', group: 'الإعدادات', icon: 'M1' },
    ];
    const merged = mergeRegistryIntoPalette(existing, registryPaletteItems('s1', all(), 'ar'));
    const ship = merged.find(i => i.href === '/stores/s1/shipping')!;
    expect(ship.icon).toBe('M1'); // the palette's own item is kept
    expect(ship.keywords).toContain('governorate');
    expect(merged.filter(i => i.href === '/stores/s1/shipping')).toHaveLength(1); // not duplicated
    expect(merged.some(i => i.href.includes('setting=shipping.area-rates'))).toBe(true);
  });
});

describe('builder deep links (Task 11)', () => {
  const entry = (id: string) => (index as IndexEntry[]).find(e => e.id === id)!;

  it('a builder entry links with select/field/page, never ?setting=', () => {
    expect(entryHref('st1', entry('builder.header-logo'))).toBe(
      '/stores/st1/builder?select=theme&field=builder.header-logo'
    );
    expect(entryHref('st1', entry('builder.page-settings'))).toBe(
      '/stores/st1/builder?page=product&field=builder.page-settings'
    );
    expect(entryHref('st1', entry('builder.look-switch'))).toBe(
      '/stores/st1/builder?field=builder.look-switch'
    );
  });

  it('Arabic and English everyday words find the editor controls', () => {
    const ctx = { role: 'store_admin', isFeatureEnabled: () => true, featuresLoading: false };
    expect(searchRegistry('الخطوط', ctx).map(h => h.entry.id)).toContain('builder.fonts');
    expect(searchRegistry('فيديو', ctx).map(h => h.entry.id)).toContain('builder.video');
    expect(searchRegistry('divider', ctx).map(h => h.entry.id)).toContain('builder.dividers');
  });
});
