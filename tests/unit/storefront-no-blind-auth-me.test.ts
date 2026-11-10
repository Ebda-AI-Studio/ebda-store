/**
 * Pre-QA sweep 2026-11-10 #7 (console noise): a guest on `/returns` logged TWO red 401s for
 * `/auth/me`, because the page asked the API who the visitor was a second time, on its own, next to
 * AuthContext. One layer owns that question: AuthContext (which asks only when it can matter, see
 * lib/session-intent.ts). A page reads the answer from `useAuth()`.
 *
 * This walks the storefront source and fails on any new file that reads `/auth/me` itself.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB_SRC = join(__dirname, '../../apps/web/src');

/** Files that may name the profile endpoint, each with the reason. */
const ALLOWED: Record<string, string> = {
  'lib/api.ts': 'the ApiClient: getProfile() is the one read, behind the session gates',
  'app/account/profile/ProfileClient.tsx':
    'PUT /auth/me: a signed-in customer saving their profile',
  'components/ReviewSection.tsx':
    'reads only behind hasSessionHint() (rendered with and without the hint in storefront-review-section-auth-gate.test.tsx)',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** A string literal that ends at the profile endpoint itself (not `/auth/me/export` and friends). */
const PROFILE_ENDPOINT = /\/auth\/me['"`]/;

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('storefront: only AuthContext asks the API who the visitor is', () => {
  const files = sourceFiles(WEB_SRC);

  it('walks the storefront source', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no page or component reads /auth/me on its own', () => {
    const offenders = files
      .filter(f => PROFILE_ENDPOINT.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => relative(WEB_SRC, f))
      .filter(f => !(f in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('every allowed file still exists and still names the endpoint (no stale allowance)', () => {
    for (const f of Object.keys(ALLOWED)) {
      expect(PROFILE_ENDPOINT.test(stripComments(readFileSync(join(WEB_SRC, f), 'utf8'))), f).toBe(
        true
      );
    }
  });
});
