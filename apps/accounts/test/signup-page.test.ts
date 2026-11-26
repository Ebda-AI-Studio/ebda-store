/**
 * accounts.ebda.app/signup?product=chat (Ruling CHAT-SA-1): the Ebda Chat sign-up page and the abuse checks on POST /signup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { call, fakes } from './helpers';
import { renderSignInPage, SIGN_IN_CSS } from '../src/sign-in-page';
import { SIGNUP_JS } from '../src/signup-page';
import { env } from 'cloudflare:test';

const PW = 'Str0ng!Passw0rd';
const fresh = (host = 'example.com') => `chat-${crypto.randomUUID().slice(0, 8)}@${host}`;
const userCount = async (email: string) =>
  (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower(?1)')
      .bind(email)
      .first<{ n: number }>()
  )?.n;

beforeEach(() => {
  fakes.mails.length = 0;
});

describe('GET /signup?product=chat', () => {
  it('serves the Chat page with a strict CSP, RTL Arabic by default, no Store wording', async () => {
    const r = await call('/signup?product=chat');
    const html = await r.text();
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('ابدأ شات');
    expect(html).not.toMatch(/ابدأ ستور|Ebda Store|متجر/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('<script src="/signup.js" defer>');
    expect(html).toContain('name="website"');
    expect(html).toContain('/login?product=chat&amp;return=https%3A%2F%2Fwa.ebda.app%2F');
  });

  it('English on request', async () => {
    const html = await (await call('/signup?product=chat&lang=en')).text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('Create your Ebda Chat account');
    expect(html).not.toMatch(/Ebda Store/);
  });

  it('keeps an allowlisted return and drops a hostile one (default is Chat, never the Store)', async () => {
    const ok = await (
      await call('/signup?product=chat&return=' + encodeURIComponent('https://wa.ebda.app/inbox'))
    ).text();
    expect(ok).toContain('data-return="https://wa.ebda.app/inbox"');
    for (const bad of ['https://evil.example/', 'javascript:alert(1)', '//evil.example']) {
      const html = await (
        await call('/signup?product=chat&return=' + encodeURIComponent(bad))
      ).text();
      expect(html).toContain('data-return="https://wa.ebda.app/"');
      expect(html).not.toContain('evil.example');
    }
  });

  it('is only the Chat page: other products go to the Store sign-up', async () => {
    const r = await call('/signup?product=store');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://store.ebda.app/signup');
  });

  it('serves the script and the honeypot style from this origin; the script posts to /signup and /otp/verify then goes to /login', async () => {
    const js = await call('/signup.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(SIGNUP_JS);
    expect(SIGNUP_JS).toContain("'/signup'");
    expect(SIGNUP_JS).toContain("'/otp/verify'");
    expect(SIGNUP_JS).toContain('window.location.assign(loginUrl)');
    expect(SIGN_IN_CSS).toContain('.hp{');
  });
});

describe('POST /signup abuse checks', () => {
  it('a normal signup creates an unverified identity with no store and mails a code', async () => {
    const email = fresh();
    const r = await call('/signup', {
      json: { email, password: PW, firstName: 'A', language: 'ar' },
    });
    expect(r.status).toBe(202);
    expect(await userCount(email)).toBe(1);
    const row = await env.DB.prepare(
      'SELECT email_verified, role FROM users WHERE lower(email)=lower(?1)'
    )
      .bind(email)
      .first<{ email_verified: number; role: string }>();
    expect(row?.email_verified).toBe(0);
    expect(fakes.mails).toHaveLength(1);
    expect(fakes.mails[0]).toMatchObject({ to: email, kind: 'email_verify' });
  });

  it('a filled honeypot gets the same 202 and nothing is created or mailed', async () => {
    const email = fresh();
    const ok = await call('/signup', { json: { email: fresh(), password: PW, firstName: 'A' } });
    const r = await call('/signup', {
      json: { email, password: PW, firstName: 'A', website: 'http://spam.example' },
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual(await ok.json());
    expect(await userCount(email)).toBe(0);
    expect(fakes.mails.filter(m => m.to === email)).toHaveLength(0);
  });

  it('a disposable domain (and a subdomain of one) gets the same 202 and nothing is created', async () => {
    for (const host of ['mailinator.com', 'x.mailinator.com']) {
      const email = fresh(host);
      const r = await call('/signup', { json: { email, password: PW, firstName: 'A' } });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ success: true, data: { status: 'verification_sent' } });
      expect(await userCount(email)).toBe(0);
    }
    expect(fakes.mails).toHaveLength(0);
  });

  it('keeps the per-email limit of 3', async () => {
    const email = fresh();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push((await call('/signup', { json: { email, password: PW, firstName: 'A' } })).status);
    expect(codes).toEqual([202, 202, 202, 429]);
  });
});

describe('Chat sign-in page: the sign-up link', () => {
  const base = { lang: 'ar' as const, returnTo: 'https://store.ebda.app/' };
  it('is hidden by default and when the flag is off', async () => {
    expect(renderSignInPage({ ...base, product: 'chat' })).not.toContain('/signup');
    fakes.envOverride = { CHAT_SIGNUP_OPEN: 'false' } as never;
    try {
      const html = await (await call('/login?product=chat')).text();
      expect(html).not.toContain('/signup');
    } finally {
      fakes.envOverride = {};
    }
  });

  it('shows the Chat sign-up link when the flag allows, carrying a validated return', () => {
    const html = renderSignInPage({
      lang: 'ar',
      product: 'chat',
      returnTo: 'https://wa.ebda.app/inbox',
      showChatSignup: true,
    });
    expect(html).toContain('معاك دعوة؟ اعمل حسابك.');
    expect(html).toContain('/signup?product=chat&amp;return=https%3A%2F%2Fwa.ebda.app%2Finbox');
    expect(html).not.toContain('store.ebda.app/signup');
  });

  it('the live /login page shows the link when CHAT_SIGNUP_OPEN is "true"', async () => {
    fakes.envOverride = { CHAT_SIGNUP_OPEN: 'true' } as never;
    try {
      const html = await (await call('/login?product=chat')).text();
      expect(html).toContain('/signup?product=chat');
    } finally {
      fakes.envOverride = {};
    }
  });

  it('the Store variant is unchanged (still links to the Store sign-up, flag or not)', () => {
    for (const showChatSignup of [false, true]) {
      const html = renderSignInPage({ ...base, product: 'store', showChatSignup });
      expect(html).toContain('href="https://store.ebda.app/signup"');
    }
  });
});

describe('Chat sign-up closed (STANDALONE_WORKSPACES off): fail closed on the server', () => {
  const closed = async (v: string | undefined, run: () => Promise<void>) => {
    fakes.envOverride = { CHAT_SIGNUP_OPEN: v } as never;
    try {
      await run();
    } finally {
      fakes.envOverride = {};
    }
  };

  it.each([['false'], [undefined], ['1'], ['TRUE']])(
    'GET /signup?product=chat is 404 with no form when CHAT_SIGNUP_OPEN=%s',
    async v =>
      closed(v, async () => {
        const r = await call('/signup?product=chat');
        expect(r.status).toBe(404);
        expect(await r.text()).not.toContain('<form');
      })
  );

  it.each([['false'], [undefined]])(
    'POST /signup is refused (404) and creates no identity, no mail, when CHAT_SIGNUP_OPEN=%s',
    async v =>
      closed(v, async () => {
        const email = fresh();
        const r = await call('/signup', { json: { email, password: PW, firstName: 'A' } });
        expect(r.status).toBe(404);
        expect(await userCount(email)).toBe(0);
        expect(fakes.mails).toHaveLength(0);
      })
  );

  it('the Store redirect still works while closed (only the Chat page is gated)', async () => {
    await closed('false', async () => {
      const r = await call('/signup?product=store');
      expect(r.status).toBe(302);
    });
  });

  it('open: the page serves and POST /signup registers', async () => {
    await closed('true', async () => {
      expect((await call('/signup?product=chat')).status).toBe(200);
      const email = fresh();
      expect(
        (await call('/signup', { json: { email, password: PW, firstName: 'A' } })).status
      ).toBe(202);
      expect(await userCount(email)).toBe(1);
    });
  });
});
