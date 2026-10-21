/**
 * Ruling SEARCH-URL-1 (launch blocker 31, closes SEARCH-T5-8 for the storefront): what a shopper
 * types into the storefront search box is often a phone number, an email or a name. In a URL it
 * lands in Cloudflare request logs, in `Referer` headers and in every ad pixel's PageView. No
 * storefront source may build a URL that carries it: the term goes in the `X-Search-Query` header
 * (API calls) or in the history entry's state (the page). The behavioural proof is
 * `apps/web/src/app/search/SearchClient.privacy.test.tsx`; this is the tripwire for a new caller.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' || n === '.next' ? [] : walk(p)) : [p];
  });
const sources = walk(join(ROOT, 'apps/web/src')).filter(
  f => /\.(ts|tsx)$/.test(f) && !/\.test\.|__tests__/.test(f)
);

/** A URL / query string that carries a free-text term. */
const URL_WITH_TERM = [
  /\/search\?[^'"`\s]*q=/, // /search?q=
  /search\/suggest\?/, // typeahead with any query
  /public\/products\?[^'"`\s]*search=/, // list with a term
  /[?&](?:q|search)=\$\{/, // any template literal that interpolates into q= / search=
  /\.set\(\s*['"](?:q|search)['"]/, // URLSearchParams.set('q' | 'search', ...)
];
const stripComments = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('no storefront source puts the search term in a URL (SEARCH-URL-1)', () => {
  it('finds the storefront sources (guards the scan itself)', () => {
    const rel = sources.map(f => relative(ROOT, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        'apps/web/src/app/search/SearchClient.tsx',
        'apps/web/src/components/SearchAutocomplete.tsx',
        'apps/web/src/components/ShopChrome.tsx',
        'apps/web/src/lib/api.ts',
      ])
    );
  });

  it('builds no such URL', () => {
    const hits: string[] = [];
    for (const f of sources) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (stripComments(line)) return;
          if (URL_WITH_TERM.some(re => re.test(line)))
            hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the API client moves `search` into the header for the list and the typeahead', () => {
    const api = readFileSync(join(ROOT, 'apps/web/src/lib/api.ts'), 'utf8');
    expect(api).toMatch(/moveSearchToHeader\(searchParams\)/);
    expect(api).toMatch(/searchQueryHeaders\(trimmed\)/);
  });
});
