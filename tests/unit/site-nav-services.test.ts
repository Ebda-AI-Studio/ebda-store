/**
 * The shared nav string renderer (help, docs, status) follows the same release flag as ebda.app (Ruling SERVICES-IA-1):
 * off = byte-for-byte the studio nav; on = the Services dropdown after Products and the coming-soon Products rows, from
 * BRAND.serviceLines / BRAND.comingProducts. The deploy workflows pass the variable through.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BRAND, serviceLinesPublishedFromEnv, siteNavHtml } from '../../packages/shared/src/brand';

const ROOT = path.resolve(__dirname, '../..');

describe('siteNavHtml and the service-lines flag', () => {
  it.each([
    [{}, false],
    [{ EBDA_SERVICE_LINES: 'off' }, false],
    [{ EBDA_SERVICE_LINES: 'preview' }, false],
    [{ EBDA_SERVICE_LINES: 'on' }, true],
    [{ EBDA_SERVICE_LINES: '1' }, true],
  ])('%j -> published %s', (env, want) => expect(serviceLinesPublishedFromEnv(env)).toBe(want));

  it.each(['ar', 'en'] as const)('%s: off has no Services or coming-soon rows', lang => {
    const html = siteNavHtml(lang, null, false);
    expect(html).not.toContain('np-soon');
    expect(html).not.toContain('/services/');
    expect(siteNavHtml(lang, null)).toBe(html); // the default (env unset) is off
  });

  it.each(['ar', 'en'] as const)(
    '%s: on adds Services after Products, and the coming-soon software',
    lang => {
      const html = siteNavHtml(lang, null, true);
      const services = lang === 'ar' ? 'الخدمات' : 'Services';
      expect(html.indexOf(`<summary>${services}</summary>`)).toBeGreaterThan(
        html.indexOf('<summary>' + (lang === 'ar' ? 'المنتجات' : 'Products'))
      );
      for (const l of BRAND.serviceLines)
        expect(html).toContain(lang === 'ar' ? l.nameAr : l.nameEn);
      for (const p of BRAND.comingProducts)
        expect(html).toContain(lang === 'ar' ? p.nameAr : p.nameEn);
      expect(html).toContain(lang === 'ar' ? 'قريبًا' : 'Coming soon');
      expect(html).toContain('/services/#core');
      // the mobile menu carries both groups too
      expect((html.match(/menu-group/g) ?? []).length).toBeGreaterThanOrEqual(4);
      // coming-soon rows are not links
      expect(html).not.toMatch(/<a [^>]*>[^<]*Ebda Invite/);
      expect(html).not.toMatch(/<a [^>]*>[^<]*Ebda CRM/);
    }
  );
});

describe('deploy workflows pass the variable through', () => {
  const wf = (n: string) =>
    readFileSync(path.join(ROOT, `.github/workflows/cf-${n}-deploy.yml`), 'utf8');
  it('help and docs builds get EBDA_SERVICE_LINES from the repo variable', () => {
    for (const n of ['help', 'docs'])
      expect(wf(n)).toContain('EBDA_SERVICE_LINES: ${{ vars.EBDA_SERVICE_LINES }}');
  });
  it('status is deployed with the variable as a Worker var (it renders at request time)', () => {
    expect(wf('status')).toMatch(/wrangler deploy --var EBDA_SERVICE_LINES:/);
  });
});
