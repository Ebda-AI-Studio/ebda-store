import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM without types
import {
  normalizeTerm,
  searchOptions,
  querySettings,
} from '../../packages/site-kit/src/search-core.mjs';
// @ts-expect-error plain ESM without types
import { parseFrontmatter, renderMdx, slugify } from '../../packages/site-kit/src/build/mdx.mjs';
import MiniSearch from 'minisearch';

describe('site-kit search normalisation', () => {
  it('folds Arabic variants so queries match across spellings', () => {
    expect(normalizeTerm('الإنشاء')).toBe(normalizeTerm('الانشاء'));
    expect(normalizeTerm('مَتْجَر')).toBe(normalizeTerm('متجر'));
    expect(normalizeTerm('مدرسة')).toBe(normalizeTerm('مدرسه'));
    expect(normalizeTerm('Shopify')).toBe('shopify');
  });

  it('finds an Arabic article by an alef/diacritic variant of its title', () => {
    const mini = new MiniSearch(searchOptions);
    mini.addAll([
      { id: '/a/', title: 'إنشاء متجر', headings: '', text: 'خطوات إنشاء متجرك', lang: 'ar' },
      { id: '/b/', title: 'Shipping', headings: '', text: 'carriers', lang: 'en' },
    ]);
    expect(mini.search('انشاء', querySettings).map(r => r.id)).toEqual(['/a/']);
    expect(mini.search('shipp', querySettings).map(r => r.id)).toEqual(['/b/']);
  });
});

describe('site-kit MDX', () => {
  it('parses flat frontmatter', () => {
    const { data, body } = parseFrontmatter('---\ntitle: "Hi"\norder: 3\n---\nBody');
    expect(data).toEqual({ title: 'Hi', order: 3 });
    expect(body).toBe('Body');
  });

  it('renders headings with stable unicode ids, wraps tables and escapes HTML', async () => {
    const { html, headings } = await renderMdx(
      '## أنشئ متجرك\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<Callout title="T">x</Callout>\n'
    );
    expect(headings).toEqual([{ id: slugify('أنشئ متجرك'), text: 'أنشئ متجرك', level: 2 }]);
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('callout');
  });
});

describe('site-kit company identity', () => {
  it('renders the company name as visible text in both locales', async () => {
    const { renderPage } = await import('../../packages/site-kit/src/build/shell.mjs');
    for (const [lang, company] of [
      ['en', 'Ebda AI Studio'],
      ['ar', 'ابدأ ستوديو'],
    ]) {
      const html = renderPage({
        lang,
        title: 'Docs',
        description: 'Docs',
        canonical: 'https://example.test/',
        siteLabel: 'Docs',
        homeHref: '/',
        nav: [],
        search: { action: '/search/', label: 'Search', placeholder: 'Search' },
        main: '<main id="main"></main>',
        footer: '',
        skipLabel: 'Skip',
      });
      const visible = html.slice(html.indexOf('<body>')).replace(/<[^>]*>/g, '');
      expect(visible).toContain(company);
    }
  });
});
