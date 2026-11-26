/**
 * STORE-QA-119 regression guards: the storefront session must be FIRST-PARTY on every host.
 *
 * (1) a host-type x account-flow matrix over the REAL `/api/v1` proxy route handler (fake upstream API, a
 *     cookie jar that behaves like Safari: only host-only, same-site cookies for the page's own host);
 * (2) static guards: no storefront code reaches api.ebda.app cross-origin with credentials, and no storefront
 *     code sets a cookie with a Domain.
 * Limit (stated, not hidden): this runs in Node, not workerd; the live check is the prod-smoke journey.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../../apps/web/src/app/api/v1/[...path]/route';
import {
  buildUpstreamHeaders,
  filterSessionCookies,
  rewriteSetCookie,
} from '../../apps/web/src/lib/auth-proxy';
import { CLIENT_IP_HEADER, SSR_AUTH_HEADER, resolveClientAddress } from '@api/cf/ssr-client-ip';
import { signClientIp } from '../../apps/web/ssr-client-address';

const ROOT = join(__dirname, '../..');

/** What api.ebda.app sets in production today (auth.routes.ts AUTH_COOKIE_OPTIONS): cross-site, Domain-less. */
const UPSTREAM_COOKIES = [
  'token=ACCESS1; Max-Age=31536000; Path=/; Expires=Sat, 20 Nov 2027 00:00:00 GMT; HttpOnly; Secure; SameSite=None',
  'refresh_token=REFRESH1; Max-Age=31536000; Path=/; Domain=.ebda.app; HttpOnly; Secure; SameSite=None',
];

describe('rewriteSetCookie', () => {
  it('re-issues a cross-site cookie as host-only, Lax, Secure, HttpOnly', () => {
    const out = rewriteSetCookie(UPSTREAM_COOKIES[1]!, true);
    expect(out).toContain('refresh_token=REFRESH1');
    expect(out).toContain('HttpOnly');
    expect(out).toContain('Path=/');
    expect(out).toContain('Max-Age=31536000');
    expect(out).toContain('SameSite=Lax');
    expect(out).toContain('Secure');
    expect(out).not.toMatch(/domain=/i);
    expect(out).not.toMatch(/SameSite=None/i);
  });
  it('keeps a deletion a deletion', () => {
    const out = rewriteSetCookie(
      'token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None',
      true
    );
    expect(out).toContain('Expires=Thu, 01 Jan 1970');
  });
  it('does not add Secure on plain http (local dev)', () => {
    expect(rewriteSetCookie('token=a; Path=/; HttpOnly', false)).not.toContain('Secure');
  });
});

describe('upstream request building', () => {
  it('relays only the two session cookies and forwards the browser Origin (cross-site stays cross-site)', () => {
    const h = new Headers({
      cookie: 'force-language=ar; token=A; _ga=1; refresh_token=R',
      'x-forwarded-for': '1.2.3.4',
      'cf-connecting-ip': '1.2.3.4',
      'x-session-id': 's1',
      'x-csrf-token': 'c1',
      origin: 'https://evil.example',
    });
    const up = buildUpstreamHeaders(h, 'https://ameliaaurum.com');
    expect(up.get('cookie')).toBe('token=A; refresh_token=R');
    expect(up.get('origin')).toBe('https://evil.example');
    expect(up.get('x-session-id')).toBe('s1');
    expect(up.get('x-csrf-token')).toBe('c1');
    expect(up.has('x-forwarded-for')).toBe(false);
    expect(up.has('cf-connecting-ip')).toBe(false);
    expect(up.get('x-ebda-proxy-hop')).toBe('1');
    expect(filterSessionCookies('a=1; b=2')).toBeNull();
    // a same-origin request that carries no Origin is named as the storefront, and a same-origin one keeps its own
    expect(buildUpstreamHeaders(new Headers(), 'https://ameliaaurum.com').get('origin')).toBe(
      'https://ameliaaurum.com'
    );
    expect(
      buildUpstreamHeaders(
        new Headers({ origin: 'https://ameliaaurum.com' }),
        'https://ameliaaurum.com'
      ).get('origin')
    ).toBe('https://ameliaaurum.com');
  });
});

describe('API: proxied browser requests keep the shopper address on every route', () => {
  const SECRET = 'test-revalidate-secret';
  it('honours a signed address on POST /auth/login only with the proxy hop flag', async () => {
    const auth = await signClientIp(SECRET, '203.0.113.7');
    const base = {
      'cf-connecting-ip': '2a06:98c0:3600::103',
      [CLIENT_IP_HEADER]: '203.0.113.7',
      [SSR_AUTH_HEADER]: auth,
    };
    const without = await resolveClientAddress(
      new Request('https://api.ebda.app/api/v1/auth/login', { method: 'POST', headers: base }),
      SECRET
    );
    expect(without.ip).toBe('2a06:98c0:3600::103');
    const withHop = await resolveClientAddress(
      new Request('https://api.ebda.app/api/v1/auth/login', {
        method: 'POST',
        headers: { ...base, 'x-ebda-proxy-hop': '1' },
      }),
      SECRET
    );
    expect(withHop).toMatchObject({ ip: '203.0.113.7', forwarded: true });
    expect(withHop.request.headers.has('x-ebda-proxy-hop')).toBe(false);
    // flag without a valid signature is worthless
    const forged = await resolveClientAddress(
      new Request('https://api.ebda.app/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '9.9.9.9',
          'x-ebda-proxy-hop': '1',
          [CLIENT_IP_HEADER]: '203.0.113.7',
          [SSR_AUTH_HEADER]: 'ab'.repeat(32),
        },
      }),
      SECRET
    );
    expect(forged.ip).toBe('9.9.9.9');
  });
});

/** A browser: stores a Set-Cookie only when it is first-party for the page host (host-only, not SameSite=None). */
class Jar {
  cookies = new Map<string, string>();
  constructor(private readonly host: string) {}
  store(setCookies: string[]) {
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(';').map(s => s.trim());
      const [name, value] = pair!.split('=');
      const lower = attrs.map(a => a.toLowerCase());
      // ITP: a cookie that names another site (Domain not this host) or is SameSite=None is third-party here.
      if (lower.some(a => a.startsWith('domain=') && a.slice(7).replace(/^\./, '') !== this.host))
        continue;
      if (lower.includes('samesite=none')) continue;
      if (/expires=thu, 01 jan 1970/i.test(c) || value === '') this.cookies.delete(name!);
      else this.cookies.set(name!, value!);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

type Upstream = { url: string; headers: Headers }[];

function installUpstream(seen: Upstream) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({ url, headers });
      const path = new URL(url).pathname;
      const h = new Headers({
        'content-type': 'application/json',
        'access-control-allow-origin': headers.get('origin')!,
      });
      if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) {
        for (const c of UPSTREAM_COOKIES) h.append('set-cookie', c);
        return new Response(JSON.stringify({ success: true, data: { refreshed: true } }), {
          status: 200,
          headers: h,
        });
      }
      if (path.endsWith('/auth/me')) {
        const ok = /token=ACCESS1/.test(headers.get('cookie') ?? '');
        return new Response(
          JSON.stringify(
            ok ? { success: true, data: { user: { role: 'customer' } } } : { success: false }
          ),
          { status: ok ? 200 : 401, headers: h }
        );
      }
      return new Response('{}', { status: 404, headers: h });
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

const HOSTS = [
  ['custom domain', 'ameliaaurum.com'],
  ['slug host', 'amelia.ebda.app'],
  ['custom domain www', 'www.ameliaaurum.com'],
] as const;

describe.each(HOSTS)('account flow on a %s (%s)', (_label, host) => {
  const call = (method: typeof GET, path: string, jar: Jar, init: RequestInit = {}) =>
    method(
      new Request(`https://${host}/api/v1${path}`, {
        ...init,
        headers: {
          host,
          cookie: jar.header(),
          'x-session-id': 's1',
          'content-type': 'application/json',
          ...(init.headers as object),
        },
      }),
      { params: Promise.resolve({ path: path.replace(/^\//, '').split('?')[0]!.split('/') }) }
    );

  it('through the route: a cross-site Origin reaches the API unchanged, a missing one is the storefront', async () => {
    const seen: Upstream = [];
    installUpstream(seen);
    const jar = new Jar(host);
    await call(POST, '/auth/login', jar, {
      method: 'POST',
      body: '{}',
      headers: { origin: 'https://evil.example' },
    });
    await call(GET, '/auth/me', jar);
    expect(seen[0]!.headers.get('origin')).toBe('https://evil.example');
    expect(seen[1]!.headers.get('origin')).toBe(`https://${host}`);
  });

  it('sign in -> open account -> reload -> still signed in; refresh keeps it; cookies are first-party', async () => {
    const seen: Upstream = [];
    installUpstream(seen);
    const jar = new Jar(host);

    const login = await call(POST, '/auth/login', jar, { method: 'POST', body: '{}' });
    expect(login.status).toBe(200);
    const issued = login.headers.getSetCookie();
    expect(issued.length).toBe(2);
    for (const c of issued) {
      expect(c).not.toMatch(/domain=/i);
      expect(c).toMatch(/SameSite=Lax/);
      expect(c).toMatch(/Secure/);
      expect(c).toMatch(/HttpOnly/);
    }
    jar.store(issued);
    expect(jar.cookies.get('token')).toBe('ACCESS1');
    expect(jar.cookies.get('refresh_token')).toBe('REFRESH1');

    // "press the account icon" then "reload": two separate /auth/me requests, each from a fresh page load
    for (let i = 0; i < 2; i++) {
      const me = await call(GET, '/auth/me', jar);
      expect(me.status).toBe(200);
    }
    const refreshed = await call(POST, '/auth/refresh', jar, { method: 'POST', body: '{}' });
    jar.store(refreshed.headers.getSetCookie());
    expect((await call(GET, '/auth/me', jar)).status).toBe(200);

    // upstream always saw the storefront host as Origin, never the API host, and only session cookies
    for (const s of seen) {
      expect(s.headers.get('origin')).toBe(`https://${host}`);
      expect(s.headers.get('x-ebda-proxy-hop')).toBe('1');
    }
    // the API's own CORS headers are not relayed (same-origin needs none)
    expect(login.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('control: the OLD cross-site cookies would have been dropped by this browser', () => {
    const jar = new Jar(host);
    jar.store(UPSTREAM_COOKIES);
    expect(jar.cookies.size).toBe(0);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === '.open-next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(p);
  }
  return out;
}

describe('static guards over the storefront (apps/web/src, every template)', () => {
  const files = walk(join(ROOT, 'apps/web/src'));
  const rel = (f: string) => relative(ROOT, f);

  it('only lib/api.ts and lib/csp.ts read NEXT_PUBLIC_API_URL (browser code must use API_URL)', () => {
    const offenders = files
      .filter(f => /NEXT_PUBLIC_API_URL/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders.sort()).toEqual(['apps/web/src/lib/api.ts', 'apps/web/src/lib/csp.ts']);
  });

  it('no storefront file hardcodes the API origin', () => {
    const offenders = files
      .filter(f => /https?:\/\/api\.ebda\.app/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter(f => f !== 'apps/web/src/lib/csp.ts');
    expect(offenders).toEqual([]);
  });

  it('the browser API base is the same-origin proxy', () => {
    const src = readFileSync(join(ROOT, 'apps/web/src/lib/api.ts'), 'utf8');
    expect(src).toMatch(/typeof window === 'undefined' \? UPSTREAM_API_URL : '\/api\/v1'/);
  });

  it('no storefront code sets a cookie with a Domain', () => {
    const offenders = files
      .filter(f => {
        const s = readFileSync(f, 'utf8');
        return (
          /document\.cookie\s*=[^;\n]*domain=/i.test(s) ||
          /cookies\(\)[\s\S]{0,200}\.set\([\s\S]{0,200}domain\s*:/i.test(s)
        );
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
