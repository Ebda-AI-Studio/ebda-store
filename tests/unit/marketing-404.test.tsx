/**
 * 404-1: ebda.app's own 404 page (static export, served by Workers Static Assets with status 404): noindex,
 * the live search box in both languages (sources: marketing + help + docs), a product-grouped site map with
 * the not-yet-live products marked "coming soon", the tappable demo phone, no orange. The HTTP 404 status and the
 * live typeahead are asserted against the BUILT site by apps/marketing/scripts/search-check.mjs.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BRAND } from '../../packages/shared/src/brand/index';

vi.mock('../../apps/marketing/src/app/globals.css', () => ({}));
// RootShell loads its fonts through next/font, which only exists inside the Next compiler.
vi.mock('next/font/google', () => {
  const font = () => ({ className: '', variable: '', style: {} });
  return { Geist: font, Geist_Mono: font, IBM_Plex_Sans_Arabic: font };
});

const { default: NotFound, metadata } =
  await import('../../apps/marketing/src/app/global-not-found');

describe('marketing 404', () => {
  const html = renderToStaticMarkup(<NotFound />);

  it('is noindex', () => {
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it('carries both languages, each with one search form wired to the live sources', () => {
    expect(html).toContain('الصفحة اللي بتدوّر عليها مش موجودة.');
    expect(html).toContain('The page you&#x27;re looking for can&#x27;t be found.');
    expect((html.match(/role="search"/g) ?? []).length).toBe(3); // header + one per language
    expect((html.match(/type="search"/g) ?? []).length).toBe(3);
    for (const src of [
      '/search-index.ar.json',
      '/search-index.en.json',
      'https://help.ebda.app/search-index.ar.json',
      'https://docs.ebda.app/search-index.en.json',
    ]) {
      expect(html).toContain(src.replace(/\//g, '/'));
    }
  });

  it('maps the site by product: Ebda Chat LIVE (linked), the coming-soon list is CRM and ERP only, from BRAND.comingProducts (not links)', () => {
    for (const label of ['ابدأ ستور', 'Ebda Store', 'ابدأ شات', 'Ebda Chat'])
      expect(html).toContain(label);
    for (const p of BRAND.comingProducts.filter(c => c.id === 'crm' || c.id === 'erp')) {
      expect(html).toContain(p.nameAr);
      expect(html).toContain(p.nameEn);
    }
    expect(html).toContain('قريبًا');
    expect(html).toContain('Coming soon');
    expect(html).not.toMatch(/<a [^>]*>Ebda (CRM|ERP|WhatsApp)<\/a>/);
    // content audit C1: Ebda Chat is live at wa.ebda.app, linked, and never inside a coming-soon item
    expect(html).toContain('href="https://wa.ebda.app/"');
    expect(html).not.toMatch(/(Ebda Chat|ابدأ شات)(<!-- -->|\s)*<b>\s*(Coming soon|قريبًا)/);
    for (const href of [
      'https://help.ebda.app',
      'https://docs.ebda.app',
      'https://status.ebda.app',
    ]) {
      expect(html).toContain(`href="${href}`);
    }
  });

  it('has a tappable demo phone that links to a live demo store, and no orange', () => {
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/storedemo-souq\.ebda\.app\/[^>]*class="nf-phone"|<a [^>]*class="nf-phone"[^>]*href="https:\/\/storedemo-souq\.ebda\.app\//
    );
    expect(html.toLowerCase()).not.toMatch(/#ff6e01|orange/);
  });
});
