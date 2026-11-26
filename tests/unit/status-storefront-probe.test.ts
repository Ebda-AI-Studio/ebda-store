import { describe, expect, it } from 'vitest';
import { COMPONENTS } from '../../apps/status/src/config';
import { DEMO_STORES } from '../../apps/marketing/src/lib/site';
import { BRAND } from '../../packages/shared/src/brand/index';

/** The storefront probe must point at a store that always exists: one of the seeded demo stores (a missing store 404s and paints "down"). */
describe('status storefront probe', () => {
  const probe = COMPONENTS.find(c => c.id === 'storefront')!;
  const host = new URL(probe.url).hostname;

  it('probes a seeded demo store, not a merchant store', () => {
    const demoHosts = Object.values(DEMO_STORES).map(s => `${s.host}${BRAND.domains.storeSuffix}`);
    expect(demoHosts).toContain(host);
    expect(host).not.toMatch(/^amelia\./);
  });

  it('asserts a storefront-specific body marker, not just <html', () => {
    expect(probe.expectBody).toBeTruthy();
    expect(probe.expectBody).not.toMatch(/^<html/i);
    expect(
      new RegExp(probe.expectBody!, 'i').test(
        '<!DOCTYPE html><html><body>Store not found</body></html>'
      )
    ).toBe(false);
    expect(new RegExp(probe.expectBody!, 'i').test('<main data-zone="hero">')).toBe(true);
  });
});

/** Custom-domain path (availability goal, 2026-11-17): the demo stores all live on *.ebda.app, so one LIVE merchant domain is probed separately. */
describe('status custom-domain storefront probe', () => {
  const probe = COMPONENTS.find(c => c.id === 'storefront-custom-domain')!;
  it('exists, is a real merchant host (not *.ebda.app) on the canonical /ar URL with the storefront body marker', () => {
    expect(probe).toBeTruthy();
    const u = new URL(probe.url);
    expect(u.hostname.endsWith(BRAND.domains.storeSuffix)).toBe(false);
    expect(u.pathname).toBe('/ar');
    expect(probe.expectStatus).toBe(200);
    expect(probe.expectBody).toBe('data-zone=');
    expect(probe.product).toBe('store');
  });
  it('the demo-store probe above stays on *.ebda.app (a deleted merchant must not paint the demo path down)', () => {
    const demo = COMPONENTS.find(c => c.id === 'storefront')!;
    expect(new URL(demo.url).hostname.endsWith(BRAND.domains.storeSuffix)).toBe(true);
  });
});
