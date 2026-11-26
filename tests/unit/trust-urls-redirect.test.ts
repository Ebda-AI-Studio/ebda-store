/**
 * QA-TRUST-1 (site trust standard): every Ebda site answers /legal, /privacy and /terms as REAL URLs. help.ebda.app,
 * docs.ebda.app and store.ebda.app returned 404. The policies live on ebda.app, so each app sends them there in ONE
 * 308 hop, keeping the language (bare and /ar -> the Arabic page, /en -> the English one); store.ebda.app also sends
 * /llms.txt to the studio's canonical file. The targets must be real pages (marketing routes exist).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(__dirname, '../..');
const PAGES = ['legal', 'privacy', 'terms'] as const;
const arTarget = (p: string) => `https://ebda.app/${p}/`;
const enTarget = (p: string) => `https://ebda.app/en/${p}/`;

/** First-match resolution of a Workers Static Assets `_redirects` file (rules: `from to status`). */
function resolveRedirects(file: string, path: string): { to: string; status: number } | null {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  for (const l of lines) {
    const [from, to, status] = l.split(/\s+/);
    if (from === path) return { to: to!, status: Number(status) };
  }
  return null;
}

describe('the targets are real pages on ebda.app', () => {
  for (const p of PAGES) {
    it(`/${p}/ and /en/${p}/ exist in the marketing app`, () => {
      expect(existsSync(join(ROOT, `apps/marketing/src/app/(ar)/${p}/page.tsx`))).toBe(true);
      expect(existsSync(join(ROOT, `apps/marketing/src/app/(en)/en/${p}/page.tsx`))).toBe(true);
    });
  }
});

describe.each(['help', 'docs'] as const)('%s.ebda.app (static assets: public/_redirects)', app => {
  const file = join(ROOT, `apps/${app}/public/_redirects`);
  for (const p of PAGES) {
    it(`/${p}, /ar/${p} -> Arabic page, /en/${p} -> English page, one 308 hop, with and without the slash`, () => {
      for (const slash of ['', '/']) {
        expect(resolveRedirects(file, `/${p}${slash}`)).toEqual({ to: arTarget(p), status: 308 });
        expect(resolveRedirects(file, `/ar/${p}${slash}`)).toEqual({
          to: arTarget(p),
          status: 308,
        });
        expect(resolveRedirects(file, `/en/${p}${slash}`)).toEqual({
          to: enTarget(p),
          status: 308,
        });
      }
    });
  }
  it('the build copies public/ into out/, so the redirects ship (site-kit resetOut)', () => {
    expect(readFileSync(join(ROOT, 'packages/site-kit/src/build/site.mjs'), 'utf8')).toContain(
      'cpSync(publicDir, outDir'
    );
  });
});

describe('store.ebda.app (the admin: next.config redirects)', () => {
  const req = createRequire(import.meta.url);
  const { trustRedirects } = req(join(ROOT, 'apps/admin/trust-redirects.js')) as {
    trustRedirects: () => Array<{ source: string; destination: string; permanent: boolean }>;
  };
  const rules = trustRedirects();
  const find = (s: string) => rules.find(r => r.source === s);

  for (const p of PAGES) {
    it(`/${p} and /ar/${p} -> Arabic page, /en/${p} -> English page, permanent (308)`, () => {
      expect(find(`/${p}`)).toEqual({ source: `/${p}`, destination: arTarget(p), permanent: true });
      expect(find(`/ar/${p}`)).toEqual({
        source: `/ar/${p}`,
        destination: arTarget(p),
        permanent: true,
      });
      expect(find(`/en/${p}`)).toEqual({
        source: `/en/${p}`,
        destination: enTarget(p),
        permanent: true,
      });
    });
  }

  it('/llms.txt goes to the studio canonical file', () => {
    expect(find('/llms.txt')).toEqual({
      source: '/llms.txt',
      destination: 'https://ebda.app/llms.txt',
      permanent: true,
    });
  });

  it('next.config.js spreads them into redirects() ahead of the admin routes', () => {
    const cfg = readFileSync(join(ROOT, 'apps/admin/next.config.js'), 'utf8');
    expect(cfg).toContain("require('./trust-redirects')");
    expect(cfg.indexOf('...trustRedirects()')).toBeGreaterThan(0);
    expect(cfg.indexOf('...trustRedirects()')).toBeLessThan(cfg.indexOf("'/stores/:id/layout'"));
  });
});
