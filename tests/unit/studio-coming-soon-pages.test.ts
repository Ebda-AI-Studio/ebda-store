/**
 * Ruling SUBDOMAIN-SOON-2: every coming-soon software product has ONE page template at <label>.ebda.app (only the copy
 * differs), and no product, live product name or service id can ever be registered or resolved as a store.
 */
import { describe, it, expect } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';
import { parseStoreHost } from '../../packages/shared/src/hosts';
import {
  renderStudioPage,
  studioHostPlan,
  STUDIO_COMING_SOON_LABELS,
  STUDIO_REDIRECT_LABELS,
} from '../../packages/shared/src/studio-pages';

const LANGS = ['ar', 'en'] as const;
const main = (html: string) =>
  html.slice(html.indexOf('>', html.indexOf('<main')) + 1, html.indexOf('</main>'));
/** The element list of <main>: tag + class, in order (the page's structure, copy stripped). */
const structure = (html: string) =>
  [...main(html).matchAll(/<([a-z0-9]+)(?:\s[^>]*?class="([^"]*)")?[^>]*>/g)].map(
    m => `${m[1]}${m[2] ? '.' + m[2] : ''}`
  );

const productLabels = STUDIO_COMING_SOON_LABELS.filter(l => {
  const p = studioHostPlan(l);
  return p.kind === 'coming-soon' && p.product !== 'reserved';
});

describe('coming-soon pages: one template, only the copy differs', () => {
  it('every BRAND.comingProducts id has a label, and the two public labels are there', () => {
    const products = new Set(
      productLabels.map(l => {
        const p = studioHostPlan(l);
        return p.kind === 'coming-soon' ? p.product : '';
      })
    );
    expect([...products].sort()).toEqual(BRAND.comingProducts.map(p => p.id).sort());
    for (const l of ['crm', 'erp']) expect(productLabels).toContain(l);
    for (const l of ['invite', 'ads', 'quote', 'quote-studio'])
      expect(productLabels).not.toContain(l);
  });

  it.each(LANGS)('%s: every product label renders the same element list', lang => {
    const ref = structure(renderStudioPage({ lang, kind: 'coming-soon', product: 'crm' }));
    // wordmark, then the product name, one line, the label, notify-me CTA and the link back, in that order
    expect(ref.slice(0, 7)).toEqual([
      'h1',
      'p.lead',
      'p.badge',
      'p.actions',
      'a.cta',
      'span.sr-only',
      'a.home',
    ]);
    for (const l of productLabels) {
      const plan = studioHostPlan(l);
      if (plan.kind !== 'coming-soon') throw new Error(l);
      const html = renderStudioPage({ lang, kind: 'coming-soon', product: plan.product });
      expect(structure(html), l).toEqual(ref);
      const b = BRAND.comingProducts.find(p => p.id === plan.product)!;
      const name = lang === 'ar' ? b.nameAr : b.nameEn;
      expect(html).toMatch(/<header>\s*<a class="brand" href="https:\/\/ebda\.app\/">/);
      expect(html).toContain(`<h1>${name}</h1>`);
      expect(html).toContain(`<p class="lead">${lang === 'ar' ? b.shortAr : b.shortEn}</p>`);
      expect(html).toContain(`<p class="badge">${lang === 'ar' ? 'قريبًا' : 'Coming soon'}</p>`);
      const home = lang === 'ar' ? 'https://ebda.app/' : 'https://ebda.app/en/';
      expect(html).toContain(`class="cta" href="${home}contact/?topic=products#form"`);
      expect(html).toContain(`class="home" href="${home}"`);
      expect(html).toContain(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`);
      expect(html).not.toMatch(/#ff6e01|orange/i);
    }
  });
});

describe('no product, live product name or service id is ever a store address', () => {
  const labels = [
    ...BRAND.comingProducts.map(p => p.id),
    'quote',
    'store',
    'wa',
    'whatsapp',
    'chat',
    ...BRAND.serviceLines.map(s => s.id),
    ...STUDIO_COMING_SOON_LABELS,
    ...STUDIO_REDIRECT_LABELS,
  ];
  it.each(labels)('%s.ebda.app is platform or invalid, never a store', label => {
    expect(['platform', 'invalid']).toContain(parseStoreHost(`${label}.ebda.app`).kind);
  });
});
