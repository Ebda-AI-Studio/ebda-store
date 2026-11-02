/** Ebda Chat (https://wa.ebda.app) is an allow-listed origin, matched EXACTLY (no wildcard, no look-alike, https only). */
import { describe, it, expect } from 'vitest';
import { call, login, seedUser } from './helpers';

const WA = 'https://wa.ebda.app';

describe('wa.ebda.app origin', () => {
  it('may fetch a whatsapp-audience token with the session cookie, with CORS headers for exactly that origin', async () => {
    const u = await seedUser();
    const s = await login(u);
    const r = await call('/token?aud=whatsapp', { cookie: s.cookie, headers: { origin: WA } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(WA);
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');
    const body = (await r.json()) as { data: { access_token: string } };
    expect(JSON.parse(atob(body.data.access_token.split('.')[1])).aud).toBe('whatsapp');
  });

  it('may sign in (login) from wa.ebda.app, and its preflight is answered', async () => {
    const u = await seedUser();
    const r = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'whatsapp' },
      headers: { origin: WA },
    });
    expect(r.status).toBe(200);
    const pre = await call('/token', { method: 'OPTIONS', headers: { origin: WA } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(WA);
  });

  it.each([
    ['a look-alike subdomain chain', 'https://wa.ebda.app.evil.com'],
    ['a look-alike prefix', 'https://evilwa.ebda.app'],
    ['plain http', 'http://wa.ebda.app'],
    ['a different port', 'https://wa.ebda.app:8443'],
    ['an unlisted sibling', 'https://crm.ebda.app'],
    ['the parent domain', 'https://ebda.app'],
  ])('refuses %s (%s)', async (_n, origin) => {
    const u = await seedUser();
    const s = await login(u);
    const r = await call('/token?aud=whatsapp', { cookie: s.cookie, headers: { origin } });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await call('/token', { method: 'OPTIONS', headers: { origin } });
    expect(pre.status).toBe(403);
  });

  it('a browser-marked cross-site request is refused even from the listed origin', async () => {
    const u = await seedUser();
    const s = await login(u);
    const r = await call('/token?aud=whatsapp', {
      cookie: s.cookie,
      headers: { origin: WA, 'sec-fetch-site': 'cross-site' },
    });
    expect(r.status).toBe(403);
  });

  it('LEAST PRIVILEGE: wa.ebda.app can only get whatsapp tokens, never store (or super-admin) ones', async () => {
    const u = await seedUser();
    const s = await login(u);
    for (const path of ['/token?aud=store', '/refresh?aud=store']) {
      const r = await call(path, {
        method: path.startsWith('/refresh') ? 'POST' : 'GET',
        cookie: s.cookie,
        headers: { origin: WA },
      });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        'ORIGIN_AUDIENCE_MISMATCH'
      );
    }
    const login403 = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'store' },
      headers: { origin: WA },
    });
    expect(login403.status).toBe(403);
  });

  it('store.ebda.app and orders.ebda.app get store tokens and not whatsapp ones', async () => {
    const u = await seedUser();
    const s = await login(u);
    for (const origin of ['https://store.ebda.app', 'https://orders.ebda.app']) {
      expect(
        (await call('/token?aud=store', { cookie: s.cookie, headers: { origin } })).status
      ).toBe(200);
      expect(
        (await call('/token?aud=whatsapp', { cookie: s.cookie, headers: { origin } })).status
      ).toBe(403);
    }
  });

  it('a request with no Origin header (server side) is not bound to an audience by this rule', async () => {
    const u = await seedUser();
    const s = await login(u);
    expect((await call('/token?aud=whatsapp', { cookie: s.cookie })).status).toBe(200);
  });
});

describe('/health reports the running version', () => {
  it('has commit and deploymentId fields (null when not deployed with them)', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ status: 'ok', service: 'accounts' });
    expect('commit' in b && 'deploymentId' in b).toBe(true);
  });
});
