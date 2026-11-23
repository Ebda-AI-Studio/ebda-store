/**
 * LANG-SWITCH-1: the language switch is a plain full-page navigation, never next/link (client router).
 * The marketing site is a static export (assets-only Worker, no `main`): the client router fetches per-segment
 * `__next.*.txt` flight files at their OWN urls, so an RSC payload can never share an edge-cache entry with the HTML
 * url. That structure is pinned here so adding a server script / switching off `output: 'export'` is a deliberate act.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// next/link renders an <a> too, so static markup cannot tell it from a plain anchor: mark it.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a data-next-link="1" href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

import { Header } from '../../apps/marketing/src/components/Header';

const root = path.join(__dirname, '../../apps/marketing');
const anchors = (html: string) => html.match(/<a\b[^>]*>/g) ?? [];

describe('language switch', () => {
  for (const [locale, page, href] of [
    ['ar', '', '/en'],
    ['en', '', '/'],
    ['en', 'store', '/store'],
  ] as const) {
    it(`${locale}/${page || 'home'}: every switch anchor is a plain <a>, not next/link`, () => {
      const html = renderToStaticMarkup(<Header locale={locale} page={page} />);
      const sw = anchors(html).filter(a => a.includes(`href="${href}"`) && /hreflang=/i.test(a));
      expect(sw.length).toBe(2); // desktop toggle + mobile menu entry
      for (const a of sw) expect(a).not.toContain('data-next-link');
      expect(
        anchors(html).some(a => a.includes('lang-toggle') && !a.includes('data-next-link'))
      ).toBe(true);
    });
  }

  it('no other component renders a locale switch through PageLink', () => {
    const src = readFileSync(path.join(root, 'src/components/Header.tsx'), 'utf8');
    expect(src).not.toMatch(/<PageLink[^>]*hrefLang/);
  });
});

describe('marketing worker serves flight data as separate static files', () => {
  it('is assets-only (no script that could mis-serve an RSC request) and a static export', () => {
    const wrangler = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8').replace(
      /\/\/.*$/gm,
      ''
    );
    expect(wrangler).not.toMatch(/"main"\s*:/);
    expect(readFileSync(path.join(root, 'next.config.js'), 'utf8')).toMatch(/output:\s*'export'/);
  });
  it('the deploy gate requires the flight files the client router fetches', () => {
    const wf = readFileSync(
      path.join(__dirname, '../../.github/workflows/cf-marketing-deploy.yml'),
      'utf8'
    );
    expect(wf).toContain('out/__next._tree.txt');
    expect(wf).toContain('out/en/__next._tree.txt');
  });
});
