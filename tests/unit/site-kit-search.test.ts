/**
 * Static-site search (help, docs): one index per locale, under the gzip budget, Arabic-folded so a
 * single letter and a differently-spelled word both match.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import MiniSearch from 'minisearch';
// @ts-expect-error plain .mjs
import {
  writeSearchAssets,
  MAX_INDEX_GZIP_BYTES,
} from '../../packages/site-kit/src/build/search.mjs';
// @ts-expect-error plain .mjs
import { searchOptions, querySettings } from '../../packages/site-kit/src/search-core.mjs';

const docs = [
  {
    url: '/a/',
    title: 'ربط الدومين',
    section: 'متجرك',
    lang: 'ar',
    headings: ['الدومين'],
    html: '<p>اربط دومين متجرك</p>',
  },
  {
    url: '/b/',
    title: 'أحذية',
    section: 'منتجات',
    lang: 'ar',
    headings: [],
    html: '<p>أحذية رياضية</p>',
  },
  {
    url: '/en/a/',
    title: 'Custom domain',
    section: 'Store',
    lang: 'en',
    headings: [],
    html: '<p>Connect a domain</p>',
  },
];

describe('writeSearchAssets', () => {
  it('writes one index per locale plus both client bundles, within the budget', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'search-'));
    const sizes = await writeSearchAssets(out, docs);
    expect(Object.keys(sizes).sort()).toEqual(['ar', 'en']);
    for (const l of ['ar', 'en']) {
      expect(existsSync(path.join(out, `search-index.${l}.json`))).toBe(true);
      expect(sizes[l].gzip).toBeLessThan(MAX_INDEX_GZIP_BYTES);
    }
    expect(existsSync(path.join(out, 'search-index.json'))).toBe(false);
    expect(existsSync(path.join(out, 'assets', 'typeahead.js'))).toBe(true);
    expect(existsSync(path.join(out, 'assets', 'search.js'))).toBe(true);

    const ar = MiniSearch.loadJSON(
      readFileSync(path.join(out, 'search-index.ar.json'), 'utf8'),
      searchOptions
    );
    const hit = (q: string) => ar.search(q, querySettings).map(r => r.id);
    expect(hit('د')).toContain('/a/'); // ONE Arabic letter
    expect(hit('احذيه')).toEqual(['/b/']); // alef + teh marbuta folded
    expect(hit('domain')).toEqual([]); // the English page is not in the Arabic index
  });

  it('fails the build when a locale index is over the gzip budget', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'search-'));
    // incompressible text: random hex words
    const noise = Array.from({ length: 60000 }, () => Math.random().toString(36).slice(2, 10)).join(
      ' '
    );
    await expect(
      writeSearchAssets(out, [
        { url: '/x/', title: 'x', section: 's', lang: 'en', headings: [], html: `<p>${noise}</p>` },
      ])
    ).rejects.toThrow(/over the .* budget/);
  });
});
