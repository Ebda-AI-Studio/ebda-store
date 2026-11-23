/**
 * `/account/login` (a natural guess, UI audit P2 #10) redirects to `/auth/login`, keeping the language prefix. The rule now
 * comes from `auth-redirects.js` (main's alias set: /login, /signup, /account/register ...), which redirects temporarily.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const cfg = createRequire(import.meta.url)('../../apps/web/next.config.js') as {
  redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>>;
};

/** Minimal path-to-regexp for the two shapes used here: literal paths and `:name(a|b)`. */
function resolve(rules: Awaited<ReturnType<typeof cfg.redirects>>, path: string): string | null {
  for (const r of rules) {
    const names: string[] = [];
    const re = new RegExp(
      '^' +
        r.source.replace(/:(\w+)\(([^)]+)\)/g, (_m, n, alts) => (names.push(n), `(${alts})`)) +
        '$'
    );
    const m = re.exec(path);
    if (m) return names.reduce((d, n, i) => d.replace(`:${n}`, m[i + 1]!), r.destination);
  }
  return null;
}

describe('/account/login redirect', () => {
  it('the redirects point at pages that exist', async () => {
    const rules = await cfg.redirects();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.destination).toMatch(/^(\/:locale)?\/auth\/(login|register)$/);
    expect(existsSync(join(__dirname, '../../apps/web/src/app/auth/login/page.tsx'))).toBe(true);
  });
  it('maps the unprefixed and both language-prefixed paths, and no unrelated account path', async () => {
    const rules = await cfg.redirects();
    expect(resolve(rules, '/account/login')).toBe('/auth/login');
    expect(resolve(rules, '/ar/account/login')).toBe('/ar/auth/login');
    expect(resolve(rules, '/en/account/login')).toBe('/en/auth/login');
    expect(resolve(rules, '/account/orders')).toBeNull();
    expect(resolve(rules, '/fr/account/login')).toBeNull();
    expect(resolve(rules, '/account/login/x')).toBeNull();
    expect(existsSync(join(__dirname, '../../apps/web/src/app/auth/register/page.tsx'))).toBe(true);
  });
});
