import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ONE layer owns the per-store chrome on a tenant-store (Track-A) page.
 *
 * `app/tenant-store/[tenant]/[locale]/layout.tsx` is still nested inside the
 * legacy `app/layout.tsx`, which SSR-renders the theme `<style>`, the
 * Organization JSON-LD and `<MarketingPixelsProvider>` (for consenting
 * visitors). If the nested layout ALSO emits them, the Phase-2 preview showed:
 * every Meta/TikTok/Snap/X/Pinterest PageView fires twice (two PageView
 * effects), a duplicate Organization JSON-LD node, and a second, divergent
 * typography `<style>` that wins cascade ties. The nested layout therefore
 * returns early while `ROOT_LAYOUT_OWNS_STORE_CHROME` is true.
 *
 * Source-level on purpose: the render path needs a live store + cookies, and
 * the defect is structural (which layer emits the chrome), not behavioural.
 */
const WEB_APP = resolve(__dirname, '../../apps/web/src/app');
const read = (rel: string) => readFileSync(resolve(WEB_APP, rel), 'utf8');

/** Source with block + line comments removed, so prose that names a tag doesn't count. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** JSX usage only (`<Name` followed by whitespace, `/` or `>`). */
const mounts = (source: string, component: string) =>
  new RegExp(`<${component}[\\s/>]`).test(code(source));

describe('tenant-store tree — single writer for store chrome', () => {
  const rootLayout = read('layout.tsx');
  const tenantLayout = code(read('tenant-store/[tenant]/[locale]/layout.tsx'));

  it('the root layout still owns the SSR consent-gated pixel provider', () => {
    expect(mounts(rootLayout, 'MarketingPixelsProvider')).toBe(true);
  });

  it('so the tenant-store layout declares the root layout the owner', () => {
    // Exactly one writer, not "at most one": if the root layout ever stops
    // mounting the provider, the tenant layout must take ownership (flag
    // false) rather than both deferring. The render test covers the HTML.
    const ownerFlag = mounts(rootLayout, 'MarketingPixelsProvider') ? 'true' : 'false';
    expect(tenantLayout).toContain(`const ROOT_LAYOUT_OWNS_STORE_CHROME: boolean = ${ownerFlag};`);
  });

  it('and returns before emitting any chrome of its own', () => {
    const early = tenantLayout.indexOf(
      'if (ROOT_LAYOUT_OWNS_STORE_CHROME) return <>{children}</>;'
    );
    expect(early).toBeGreaterThan(-1);
    for (const marker of ['<style', '<JsonLd', '<ConsentGatedMarketingPixels']) {
      const at = tenantLayout.indexOf(marker);
      if (at !== -1) expect(at).toBeGreaterThan(early);
    }
    // No pixel provider mounted directly, bypassing the early return.
    expect(mounts(tenantLayout, 'MarketingPixelsProvider')).toBe(false);
  });
});
