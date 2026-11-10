/**
 * A link to a FILE on ebda.app (security.txt, sitemap.xml, llms.txt, an image, a PDF) must be a plain anchor, never a
 * Next <Link>: with `trailingSlash: true` the client router rewrote the footer's `/.well-known/security.txt` to
 * `/.well-known/security/`, a 404 (live 2026-11-10). Every marketing link goes through `PageLink`, which sends only
 * extension-less root-relative paths to the router. `next/link` is mocked to mark what it renders, so this fails when
 * any rendered file link goes through the router. The click itself is proven on the built site by
 * tests/marketing-layout/file-links.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a data-next-link="" href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { isPagePath, PageLink } = await import('../../apps/marketing/src/components/PageLink');
const { Footer } = await import('../../apps/marketing/src/components/Footer');
const { Header } = await import('../../apps/marketing/src/components/Header');
const { ContactPage } = await import('../../apps/marketing/src/components/ContactPage');

const FILE_EXT = /\.[a-z0-9]+$/i;
const routed = (html: string) =>
  [...html.matchAll(/<a data-next-link="" href="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0]);

describe('isPagePath', () => {
  it.each([
    '/',
    '/en/',
    '/features/',
    '/en/legal/data-deletion/',
    '/#products',
    '/en/?q=1',
    '/.well-known/',
  ])('%s is a page', href => expect(isPagePath(href)).toBe(true));
  it.each([
    '/.well-known/security.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/site.webmanifest',
    '/og/home.png',
    '/docs/terms.pdf',
    '/sitemap.xml?x=1',
    'mailto:security@ebda.app',
    'tel:+20100',
    'https://help.ebda.app/',
    '//cdn.example/x',
    '#main',
  ])('%s is not a page', href => expect(isPagePath(href)).toBe(false));
});

describe('PageLink', () => {
  it('routes a page and renders a file as a plain anchor', () => {
    expect(renderToStaticMarkup(<PageLink href="/features/">x</PageLink>)).toContain(
      'data-next-link'
    );
    const file = renderToStaticMarkup(<PageLink href="/.well-known/security.txt">x</PageLink>);
    expect(file).toBe('<a href="/.well-known/security.txt">x</a>');
  });
});

describe('rendered marketing links', () => {
  for (const locale of ['ar', 'en'] as const) {
    const html = renderToStaticMarkup(
      <>
        <Header locale={locale} />
        <ContactPage locale={locale} />
        <Footer locale={locale} />
      </>
    );

    it(`${locale}: no file link goes through the client router`, () => {
      const r = routed(html);
      expect(r.length).toBeGreaterThan(5); // the mock is live: pages still route
      expect(r.filter(h => FILE_EXT.test(h.split(/[?#]/)[0]))).toEqual([]);
    });

    it(`${locale}: the footer security.txt link is a plain anchor`, () => {
      const sec = anchors(html).filter(a => a.includes('/.well-known/security.txt'));
      expect(sec.length).toBeGreaterThan(0);
      for (const a of sec) expect(a).not.toContain('data-next-link');
    });
  }
});

describe('next/link stays behind PageLink', () => {
  it('no marketing source file imports next/link except PageLink.tsx', () => {
    const root = path.resolve(__dirname, '../../apps/marketing/src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(t|j)sx?$/.test(e.name) && !p.endsWith('PageLink.tsx')) {
          if (/from\s+['"]next\/link['"]/.test(readFileSync(p, 'utf8')))
            offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
