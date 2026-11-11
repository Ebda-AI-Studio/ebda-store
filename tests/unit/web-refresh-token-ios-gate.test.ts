/**
 * #1945 — the storefront reads a localStorage refresh token ONLY on iOS WebKit.
 *
 * Every WRITE of `refreshToken` to localStorage is iOS-gated, but the web
 * client's READ was not (admin and orders already read
 * `ios ? localStorage.getItem('refreshToken') : null`). A non-iOS browser
 * carrying a leftover entry therefore took the body-token branch of
 * /auth/refresh forever — shipping a 365-day token in a JS-visible body and
 * never refreshing from its httpOnly cookie — and logout() revoked that stale
 * token instead of the live cookie session.
 *
 * Same fetch/localStorage stand-ins as refresh-throttle-not-logout.test.ts
 * (jsdom is not a dependency of this repo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ts from 'typescript';
import { all, callsIn, declNamed, parseFile, strVal } from './helpers/ast-statements';

const ORIGINAL_FETCH = globalThis.fetch;

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

const store = makeLocalStorage();
vi.stubGlobal('localStorage', store);
vi.stubGlobal('window', { localStorage: store });

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

/** Body of the first fetch whose URL contains `path`, parsed. */
function bodyOf(path: string): Record<string, unknown> | undefined {
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
    String(url).includes(path)
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('accessToken', 'stale-access');
  localStorage.setItem('refreshToken', 'legacy-residue');
  globalThis.fetch = vi.fn(async (url: unknown) =>
    String(url).includes('/auth/refresh') ? res(401) : res(401, { success: false })
  ) as never;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', { localStorage: store });
});

describe('web client — refresh token read is iOS-gated (#1945)', () => {
  it('non-iOS: refreshes from the cookie (empty body) and clears the residue', async () => {
    vi.stubGlobal('navigator', { userAgent: DESKTOP_UA });
    const { api } = await import('@web/lib/api');

    await api.getCart();

    expect(bodyOf('/auth/refresh')).toEqual({});
    expect(localStorage.getItem('refreshToken')).toBeNull();
  });

  it('iOS: still sends the stored token in the body (the only copy there)', async () => {
    // Negative control: a gate that dropped the token everywhere would pass
    // the case above and sign every iOS PWA user out.
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
    const { api } = await import('@web/lib/api');

    await api.getCart();

    expect(bodyOf('/auth/refresh')).toEqual({ refreshToken: 'legacy-residue' });
  });

  it('non-iOS logout does not send the stale residue in place of the cookie', async () => {
    vi.stubGlobal('navigator', { userAgent: DESKTOP_UA });
    globalThis.fetch = vi.fn(async () => res(200, { success: true })) as never;
    const { api } = await import('@web/lib/api');

    await api.logout();

    expect(bodyOf('/auth/logout')).toEqual({ refreshToken: null });
  });
});

describe('admin + orders logout — same iOS gate on the read (#1945 sibling)', () => {
  // Their logout() lives in React providers (auth.tsx); the one-line read is pinned on the parsed function (AST:
  // real call nodes, so a comment cannot satisfy or trip it) so a revert to an ungated read goes red.
  it.each(['apps/admin/src/lib/auth.tsx', 'apps/orders/src/lib/auth.tsx'])('%s', file => {
    const logout = declNamed(parseFile(file), 'logout');
    // #2034: the gated read is the helper that also removes non-iOS residue.
    const gated = callsIn(logout, 'readStoredRefreshToken').map(c =>
      c.arguments.map(a => a.getText())
    );
    expect(gated).toEqual([['isIosWebkit()']]);
    const ungated = callsIn(logout, 'localStorage.getItem').filter(
      c => strVal(c.arguments[0]) === 'refreshToken'
    );
    expect(ungated).toEqual([]);
  });
});

describe('admin + orders — a non-iOS refresh removes the residue copy (#2034)', () => {
  it.each(['@admin/lib/api', '@orders/lib/api'])('%s', async mod => {
    const { readStoredRefreshToken } = (await import(mod)) as {
      readStoredRefreshToken: (ios: boolean) => string | null;
    };
    localStorage.setItem('refreshToken', 'residue');
    expect(readStoredRefreshToken(true)).toBe('residue');
    expect(localStorage.getItem('refreshToken'), 'iOS keeps its only copy').toBe('residue');
    expect(readStoredRefreshToken(false)).toBeNull();
    expect(localStorage.getItem('refreshToken'), 'elsewhere it is removed').toBeNull();
  });

  // Rulings ID-1/ID-2: admin and orders no longer hold ANY refresh token in JS; the session is the identity service's own
  // HttpOnly cookie. Their refresh asks it for a Store token and exchanges that for the API cookie.
  it.each(['apps/admin/src/lib/api.ts', 'apps/orders/src/lib/api.ts'])(
    '%s: refreshAccessToken uses the identity service and reads/writes no refresh token',
    file => {
      // AST of the exported function: its calls and its identifiers / string literals, comments excluded.
      const fn = declNamed(parseFile(file), 'refreshAccessToken');
      expect(callsIn(fn, 'accountsToken').length).toBeGreaterThan(0);
      expect(callsIn(fn, 'establishApiSession').length).toBeGreaterThan(0);
      const tokens = [
        ...all(fn, ts.isIdentifier).map(i => i.text),
        ...all(fn, ts.isStringLiteral).map(l => l.text),
        ...all(fn, ts.isNoSubstitutionTemplateLiteral).map(l => l.text),
      ];
      expect(tokens.filter(t => /refreshToken|\/auth\/refresh/.test(t))).toEqual([]);
    }
  );
});
