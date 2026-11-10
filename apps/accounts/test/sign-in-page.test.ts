/**
 * accounts.ebda.app/login: the Ebda AI Studio sign-in page (Ruling ACCOUNTS-PAGE-1).
 * The page is a thin client over the SAME POST /login and /login/mfa the Store sign-in calls; these tests pin the
 * open-redirect boundary, the page's headers, and that the existing CSRF, audience, limiter and cookie rules still hold
 * for a request from the page's own origin.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { call, cookieOf, emailCodeFor, fakes, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';
import { renderSignInPage, SIGN_IN_JS } from '../src/sign-in-page';

const PAGE = 'https://accounts.ebda.app';
const DEFAULT = 'https://store.ebda.app/';
const fromPage = { origin: PAGE, 'sec-fetch-site': 'same-origin' };

beforeEach(() => {
  fakes.stores = [];
  fakes.mails.length = 0;
  fakes.directoryDown = false;
});

const page = async (query = '', headers: Record<string, string> = {}) => {
  const r = await call(`/login${query}`, { headers });
  return { r, html: await r.text() };
};
const dataReturn = (html: string) => {
  const m = /data-return="([^"]*)"/.exec(html);
  return m ? m[1].replaceAll('&amp;', '&') : null;
};

describe('the page', () => {
  it('is Ebda AI Studio, Arabic by default, English on request', async () => {
    const ar = await page();
    expect(ar.r.status).toBe(200);
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(ar.html).toContain('ابدأ ستوديو للذكاء الاصطناعي');
    expect(ar.html).not.toContain('ابدأ ستور</title>');
    const en = await page('?lang=en');
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(en.html).toContain('Ebda AI Studio');
    const accept = await page('', { 'accept-language': 'en-US,en;q=0.9' });
    expect(accept.html).toContain('lang="en"');
  });

  it('sends a strict CSP, noindex and no-store', async () => {
    const { r, html } = await page();
    const csp = r.headers.get('content-security-policy') ?? '';
    for (const d of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ])
      expect(csp).toContain(d);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('has no inline script or inline style (only /sign-in.js and a JSON data block)', async () => {
    const { html } = await page('?lang=en');
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBe(2);
    for (const s of scripts)
      expect(
        s === '<script src="/sign-in.js" defer>' || s.includes('type="application/json"')
      ).toBe(true);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('forms are POST and never carry an action (nothing reaches a URL without the script)', async () => {
    const { html } = await page();
    const forms = html.match(/<form\b[^>]*>/g) ?? [];
    expect(forms.length).toBe(2);
    for (const f of forms) {
      expect(f).toContain('method="post"');
      expect(f).not.toContain('action=');
    }
  });

  it('never echoes credentials put in the query string', async () => {
    const { html } = await page('?email=victim%40x.co&password=Hunter2Secret&code=123456');
    expect(html).not.toContain('Hunter2Secret');
    expect(html).not.toContain('victim@x.co');
    expect(html).not.toContain('123456');
  });

  it('serves its script and stylesheet from this Worker', async () => {
    const js = await call('/sign-in.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    const css = await call('/sign-in.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('the script calls only this origin, with the Store page’s exact request bodies', () => {
    const paths = [...SIGN_IN_JS.matchAll(/post\('([^']+)'/g)].map(m => m[1]);
    expect(paths.sort()).toEqual(['/login', '/login/mfa']);
    expect(SIGN_IN_JS).toContain("aud: 'store'");
    expect(SIGN_IN_JS).toContain("credentials: 'same-origin'");
    expect(SIGN_IN_JS).not.toMatch(/https?:\/\/[a-z]/i);
    expect(SIGN_IN_JS).not.toMatch(/console\.|localStorage|sessionStorage|innerHTML/);
  });
});

describe('product: an allowlist that names the product, never the raw value', () => {
  it('whatsapp and chat name Ebda Chat; store names Ebda Store; absent or unknown is the generic studio sign-in', async () => {
    expect((await page('?product=whatsapp&lang=en')).html).toContain(
      '<h1>Sign in to Ebda Chat</h1>'
    );
    expect((await page('?product=chat')).html).toContain('<h1>تسجيل الدخول لابدأ شات</h1>');
    expect((await page('?product=store&lang=en')).html).toContain('<h1>Sign in to Ebda Store</h1>');
    expect((await page('?lang=en')).html).toContain('<h1>Sign in</h1>');
    const odd = await page('?product=%3Cimg%20src%3Dx%3Eevilproduct&lang=en');
    expect(odd.html).toContain('<h1>Sign in</h1>');
    expect(odd.html).not.toContain('evilproduct');
    expect(odd.html).not.toContain('<img');
  });
});

describe('the Ebda Chat flow, end to end (contract: ebda-whatsapp web/src/data/auth.ts)', () => {
  it('401 on /token -> /login?product=whatsapp&return=<wa url> -> sign in -> back on that URL with a whatsapp session', async () => {
    const waUrl = 'https://wa.ebda.app/inbox/c-42?tab=open';
    const wa = { origin: 'https://wa.ebda.app', 'sec-fetch-site': 'same-site' };
    // 1. Chat asks for a token while signed out.
    const before = await call('/token?aud=whatsapp', { headers: wa });
    expect(before.status).toBe(401);
    expect(((await before.json()) as { error: { code: string } }).error.code).toBe('NO_SESSION');
    // 2. Chat sends the browser to the accounts page, exactly as auth.ts builds the URL.
    const entry = `/login?product=whatsapp&return=${encodeURIComponent(waUrl)}`;
    const landing = await call(entry, { redirect: 'manual' });
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain('تسجيل الدخول لابدأ شات');
    const dest = dataReturn(html);
    expect(dest).toBe(waUrl);
    // 3. The page's script signs in with the Store page's body, from its own origin.
    const u = await seedUser();
    const signIn = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'store' },
      headers: fromPage,
    });
    expect(signIn.status).toBe(200);
    const body = (await signIn.json()) as { data: { mfaEnrollmentRequired?: boolean } };
    expect(body.data.mfaEnrollmentRequired).toBeUndefined();
    // 4. The script navigates to `dest` (the validated wa URL); Chat's /token now answers with its own audience.
    const after = await call('/token?aud=whatsapp', { cookie: cookieOf(signIn), headers: wa });
    expect(after.status).toBe(200);
    const grant = (await after.json()) as { data: { access_token: string } };
    expect(grant.data.access_token.split('.').length).toBe(3);
  });
});

describe('return: the open-redirect boundary (Ruling SIGNIN-RETURN-1 allowlist)', () => {
  it('keeps an allowlisted https URL (return and the return_to alias)', async () => {
    for (const ok of [
      'https://wa.ebda.app/inbox?a=1&b=2',
      'https://store.ebda.app/orders',
      'https://orders.ebda.app/',
      'https://ebda.app/pricing',
    ]) {
      expect(dataReturn((await page(`?return=${encodeURIComponent(ok)}`)).html), ok).toBe(ok);
    }
    expect(
      dataReturn((await page(`?return_to=${encodeURIComponent('https://wa.ebda.app/x')}`)).html)
    ).toBe('https://wa.ebda.app/x');
  });

  it('defaults to the Store when absent', async () => {
    expect(dataReturn((await page()).html)).toBe(DEFAULT);
  });

  it('refuses every other form', async () => {
    for (const bad of [
      'https://evil.example/',
      'https://evil.example/https://wa.ebda.app/',
      '//evil.example/',
      '/\\evil.example',
      'https:evil.example',
      'https:/evil.example',
      'https:\\\\evil.example',
      'https://wa.ebda.app\\@evil.example/',
      'https://ebda.app@evil.example/',
      'https://user:pw@wa.ebda.app/',
      'http://wa.ebda.app/',
      'https://wa.ebda.app:8443/',
      'https://wa.ebda.app.evil.example/',
      'https://evil-ebda.app/',
      'https://xn--wa-ebda.app/',
      'https://accounts.ebda.app/login',
      'https://store.ebda.app/login',
      'javascript:alert(1)',
      ' https://wa.ebda.app/',
      'https://wa.ebda.app/\n',
      'https://wa.ebda.app/' + 'a'.repeat(3000),
    ]) {
      expect(dataReturn((await page(`?return=${encodeURIComponent(bad)}`)).html), bad).toBe(
        DEFAULT
      );
      // double-encoded: the decoded value is still a non-URL string and must not slip through either
      expect(
        dataReturn((await page(`?return=${encodeURIComponent(encodeURIComponent(bad))}`)).html),
        `enc:${bad}`
      ).toBe(DEFAULT);
    }
  });

  it('a hostile but allowlisted URL cannot break out of the attribute', async () => {
    const { html } = await page(
      `?return=${encodeURIComponent('https://wa.ebda.app/"><script>alert(1)</script>')}`
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('"><script');
  });

  it('the renderer escapes the destination itself (defence in depth under the URL parser)', () => {
    const html = renderSignInPage({
      lang: 'en',
      product: 'store',
      returnTo: 'https://wa.ebda.app/"><script>alert(1)</script>',
    });
    expect(html).not.toContain('"><script');
    expect(html).toContain('data-return="https://wa.ebda.app/&quot;&gt;&lt;script&gt;');
  });

  it('the language switch and the passkey link carry only product + the validated return', async () => {
    const evil = encodeURIComponent('https://evil.example/');
    const { html } = await page(`?product=chat&return=${evil}`);
    expect(html).not.toContain('evil.example');
    const good = await page(`?product=chat&return=${encodeURIComponent('https://wa.ebda.app/i')}`);
    expect(good.html).toContain(
      'href="https://store.ebda.app/login?product=chat&amp;return=https%3A%2F%2Fwa.ebda.app%2Fi"'
    );
    expect(good.html).toContain('href="/login?lang=en&amp;product=chat&amp;return=');
  });
});

describe('signing in from the page origin uses the existing rules unchanged', () => {
  it('password -> the same __Host- session cookie, which Ebda Chat then reads through /token', async () => {
    const u = await seedUser();
    const r = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'store' },
      headers: fromPage,
    });
    expect(r.status).toBe(200);
    const raw = r.headers.getSetCookie().find(c => c.startsWith('__Host-ebda_rt='))!;
    expect(raw).toMatch(/; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect(raw).not.toMatch(/Domain=/i);
    const t = await call('/token?aud=whatsapp', {
      cookie: cookieOf(r),
      headers: { origin: 'https://wa.ebda.app', 'sec-fetch-site': 'same-site' },
    });
    expect(t.status).toBe(200);
  });

  it('password + TOTP from the page origin', async () => {
    const u = await seedUser();
    const s = await login(u);
    const secret = (
      (await (
        await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token })
      ).json()) as { data: { secret: string } }
    ).data.secret;
    await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret), emailCode: await emailCodeFor(u, s.body.access_token) },
      bearer: s.body.access_token,
    });
    await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
      .bind(s.body.user.id)
      .run();
    const first = (await (
      await call('/login', {
        json: { email: u.email, password: u.password, aud: 'store' },
        headers: fromPage,
      })
    ).json()) as { data: { mfaRequired: boolean; challenge: string } };
    expect(first.data.mfaRequired).toBe(true);
    const done = await call('/login/mfa', {
      json: { challenge: first.data.challenge, code: await totpAt(secret) },
      headers: fromPage,
    });
    expect(done.status).toBe(200);
    expect(cookieOf(done)).toMatch(/^__Host-ebda_rt=.+/);
  });

  it('CSRF: a cross-site request, a foreign Origin and a form post are still refused', async () => {
    const u = await seedUser();
    const body = { email: u.email, password: u.password, aud: 'store' };
    const cross = await call('/login', {
      json: body,
      headers: { origin: PAGE, 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
    const foreign = await call('/login', {
      json: body,
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    const form = await call('/login', {
      method: 'POST',
      headers: { ...fromPage, 'content-type': 'text/plain' },
      body: JSON.stringify(body),
    });
    expect(form.status).toBe(415);
    expect(cookieOf(cross) + cookieOf(foreign) + cookieOf(form)).toBe('');
  });

  it('least privilege: the page origin may only ask for the store audience', async () => {
    const u = await seedUser();
    const r = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'whatsapp' },
      headers: fromPage,
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'ORIGIN_AUDIENCE_MISMATCH'
    );
  });

  it('the login limiter is the same one: 5 wrong passwords lock the account, even from the page', async () => {
    const u = await seedUser();
    const ip = '198.51.100.9';
    for (let i = 0; i < 5; i++) {
      const r = await call('/login', {
        json: { email: u.email, password: 'wrong-password', aud: 'store' },
        headers: { ...fromPage, 'cf-connecting-ip': ip },
      });
      expect(r.status).toBe(401);
    }
    const locked = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'store' },
      headers: { ...fromPage, 'cf-connecting-ip': ip },
    });
    expect(locked.status).toBe(429);
  });

  it('no password or code is written to the logs', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map(m =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    );
    try {
      const u = await seedUser({ password: 'Unique!Pass-5150' });
      await call('/login', {
        json: { email: u.email, password: 'Unique!Pass-5150', aud: 'store' },
        headers: fromPage,
      });
      await call('/login', {
        json: { email: u.email, password: 'Wrong!Pass-5150', aud: 'store' },
        headers: fromPage,
      });
      await call('/login/mfa', {
        json: { challenge: 'x'.repeat(20), code: '987654' },
        headers: fromPage,
      });
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    const all = lines.join('\n');
    expect(all).not.toContain('Pass-5150');
    expect(all).not.toContain('987654');
  });
});

describe('every other route answers as before', () => {
  it('health, discovery, token, sessions, 404', async () => {
    expect((await call('/health')).status).toBe(200);
    expect((await call('/.well-known/jwks.json')).status).toBe(200);
    expect((await call('/.well-known/openid-configuration')).status).toBe(200);
    const t = await call('/token?aud=whatsapp');
    expect(t.status).toBe(401);
    expect(((await t.json()) as { error: { code: string } }).error.code).toBe('NO_SESSION');
    expect((await call('/me')).status).toBe(401);
    const nf = await call('/nope', { headers: { accept: 'text/html' } });
    expect(nf.status).toBe(404);
    const nfJson = await call('/nope');
    expect(nfJson.status).toBe(404);
    expect(nfJson.headers.get('content-type')).toContain('application/json');
  });
});
