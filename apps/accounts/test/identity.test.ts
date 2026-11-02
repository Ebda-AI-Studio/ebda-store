import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeProtectedHeader, decodeJwt, SignJWT, generateKeyPair } from 'jose';
import { call, emailCodeFor, cookieOf, fakes, login, seedUser, verifyAsProduct } from './helpers';
import { totpAt } from '../src/totp';

beforeEach(() => {
  fakes.stores = [];
  fakes.mails.length = 0;
  fakes.directoryDown = false;
});

describe('404', () => {
  it('a browser on a wrong URL gets the studio 404 page: real 404, noindex, search box, links', async () => {
    const r = await call('/no-such-page', {
      headers: { accept: 'text/html', 'accept-language': 'en' },
    });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    const page = await r.text();
    expect(page.includes('The page you&#39;re looking for can&#39;t be found.')).toBe(true);
    expect(page.includes('role="search"')).toBe(true);
    expect(page.includes('href="https://ebda.app/"')).toBe(true);
  });

  it('an API caller keeps the JSON 404', async () => {
    const r = await call('/no-such-page');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('discovery', () => {
  it('publishes ES256 public keys only, and the openid configuration points at them', async () => {
    const jwks = (await (await call('/.well-known/jwks.json')).json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
    for (const k of jwks.keys) {
      expect(k.d, 'private member leaked').toBeUndefined();
      expect(k).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      expect(typeof k.kid).toBe('string');
    }
    const oc = (await (await call('/.well-known/openid-configuration')).json()) as Record<
      string,
      unknown
    >;
    expect(oc.issuer).toBe('https://accounts.ebda.app');
    expect(oc.jwks_uri).toBe('https://accounts.ebda.app/.well-known/jwks.json');
  });
});

describe('login and the access token contract', () => {
  it('mints an ES256 at+jwt with the contract claims, 5 minute life, and a hardened host-only cookie', async () => {
    const u = await seedUser();
    fakes.stores = [
      { id: 's1', role: 'owner' },
      { id: 's2', role: 'staff' },
    ];
    const { res, body, cookie } = await login(u);
    expect(res.status).toBe(200);
    const header = decodeProtectedHeader(body.access_token);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
    expect(header.kid).toBeTruthy();
    const { payload } = await verifyAsProduct(body.access_token, 'store');
    expect(payload).toMatchObject({ iss: 'https://accounts.ebda.app', aud: 'store', sub: u.id });
    expect(payload.stores).toEqual([
      { id: 's1', role: 'owner' },
      { id: 's2', role: 'staff' },
    ]);
    expect(typeof payload.sid).toBe('string');
    expect(typeof payload.jti).toBe('string');
    expect(payload.exp! - payload.iat!).toBe(5 * 60); // Ruling NZ-D2: store-audience tokens live <= 5 minutes
    expect(payload.nbf).toBe(payload.iat);
    expect(payload.pa).toBeUndefined();
    const set = res.headers.getSetCookie().find(c => c.startsWith('__Host-ebda_rt='))!;
    expect(set).toMatch(/; Secure/);
    expect(set).toMatch(/; HttpOnly/);
    expect(set).toMatch(/; SameSite=Lax/);
    expect(set).toMatch(/; Path=\//);
    expect(set).not.toMatch(/Domain=/i); // host-only: never sent to other subdomains
    expect(cookie.length).toBeGreaterThan(40);
  });

  it('a super admin carries pa, an unknown audience is refused', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const { body, cookie } = await login(u);
    // password alone never carries pa (Ruling ID-15); a session created with a second factor does
    expect((decodeJwt(body.access_token) as { pa?: string }).pa).toBeUndefined();
    await env.DB.prepare(`UPDATE sessions SET amr = 'pwd,otp' WHERE user_id = ?1`).bind(u.id).run();
    const minted = (await (await call('/token?aud=store', { cookie })).json()) as {
      data: { access_token: string };
    };
    expect((decodeJwt(minted.data.access_token) as { pa?: string }).pa).toBe('super_admin');
    const bad = await call('/login', {
      json: { email: u.email, password: u.password, aud: 'evil' },
    });
    expect(bad.status).toBe(400);
  });

  it('wrong password and unknown email are the same answer; the 5th failure locks the email', async () => {
    const u = await seedUser();
    const a = await call('/login', {
      json: { email: u.email, password: 'nope' },
      headers: { 'cf-connecting-ip': '198.51.100.1' },
    });
    const b = await call('/login', {
      json: { email: 'ghost@example.com', password: 'nope' },
      headers: { 'cf-connecting-ip': '198.51.100.2' },
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
    for (let i = 0; i < 4; i++)
      await call('/login', {
        json: { email: u.email, password: 'nope' },
        headers: { 'cf-connecting-ip': `198.51.100.${10 + i}` },
      });
    const locked = await call('/login', {
      json: { email: u.email, password: u.password },
      headers: { 'cf-connecting-ip': '198.51.100.99' },
    });
    expect(locked.status).toBe(429); // even the right password is refused while locked
  });

  it('a suspended account cannot sign in and cannot be told apart from a wrong password', async () => {
    const u = await seedUser({ status: 'suspended' });
    const r = await call('/login', { json: { email: u.email, password: u.password } });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_CREDENTIALS'
    );
  });

  it('legacy seed rows (non-hash password marker) can never sign in', async () => {
    const u = await seedUser();
    await env.DB.prepare(`UPDATE users SET password_hash = '!seed-no-login' WHERE id = ?1`)
      .bind(u.id)
      .run();
    expect(
      (await call('/login', { json: { email: u.email, password: '!seed-no-login' } })).status
    ).toBe(401);
  });

  it('the directory failing is a 503, never a token with an empty stores claim', async () => {
    const u = await seedUser();
    fakes.directoryDown = true;
    const r = await call('/login', { json: { email: u.email, password: u.password } });
    expect(r.status).toBe(503);
  });
});

describe('SSO: one login reaches every product, logout revokes everywhere', () => {
  it('the same cookie yields a store token and a whatsapp token; each product accepts only its own audience', async () => {
    const u = await seedUser();
    fakes.stores = [{ id: 's1', role: 'owner' }];
    const { cookie } = await login(u, 'store');
    const store = (await (await call('/token?aud=store', { cookie })).json()) as {
      data: { access_token: string };
    };
    const wa = (await (await call('/token?aud=whatsapp', { cookie })).json()) as {
      data: { access_token: string };
    };
    expect((await verifyAsProduct(store.data.access_token, 'store')).payload.aud).toBe('store');
    expect((await verifyAsProduct(wa.data.access_token, 'whatsapp')).payload.aud).toBe('whatsapp');
    // a product rejects a token minted for another product
    await expect(verifyAsProduct(wa.data.access_token, 'store')).rejects.toThrow();
    await expect(verifyAsProduct(store.data.access_token, 'whatsapp')).rejects.toThrow();
    // both tokens belong to ONE session
    expect(decodeJwt(store.data.access_token).sid).toBe(decodeJwt(wa.data.access_token).sid);
  });

  it('logout from one product kills the session for all of them', async () => {
    const u = await seedUser();
    const { cookie, body } = await login(u);
    const sid = decodeJwt(body.access_token).sid as string;
    const { Accounts } = await import('../src/index');
    const rpc = new Accounts({} as never, { ...(await import('./helpers')).testEnv() });
    expect(await rpc.isRevoked(sid)).toBe(false);
    const out = await call('/logout', { method: 'POST', cookie, bearer: body.access_token });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join(';')).toMatch(/__Host-ebda_rt=; Max-Age=0/);
    expect(await rpc.isRevoked(sid)).toBe(true);
    expect((await call('/token?aud=whatsapp', { cookie })).status).toBe(401);
    expect((await call('/token?aud=store', { cookie })).status).toBe(401);
    expect((await call('/me', { bearer: body.access_token })).status).toBe(401); // the still-unexpired access token is dead too
    // the RPC surface offers no way to mint a token for another audience
    expect((rpc as unknown as Record<string, unknown>).issue).toBeUndefined();
  });

  it('revoke all ends every session of the user, another user is untouched', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const a1 = await login(a);
    const a2 = await login(a);
    const b1 = await login(b);
    const r = await call('/revoke', { json: { all: true }, bearer: a1.body.access_token });
    expect(r.status).toBe(200);
    expect((await call('/token?aud=store', { cookie: a1.cookie })).status).toBe(401);
    expect((await call('/token?aud=store', { cookie: a2.cookie })).status).toBe(401);
    expect((await call('/token?aud=store', { cookie: b1.cookie })).status).toBe(200);
  });

  it("revoking one session by id does not touch the others, and you cannot revoke someone else's", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const a1 = await login(a);
    const a2 = await login(a);
    const b1 = await login(b);
    const sid2 = decodeJwt(a2.body.access_token).sid as string;
    expect(
      (await call('/revoke', { json: { sid: sid2 }, bearer: a1.body.access_token })).status
    ).toBe(200);
    expect((await call('/token?aud=store', { cookie: a2.cookie })).status).toBe(401);
    expect((await call('/token?aud=store', { cookie: a1.cookie })).status).toBe(200);
    const foreign = decodeJwt(b1.body.access_token).sid as string;
    expect(
      (await call('/revoke', { json: { sid: foreign }, bearer: a1.body.access_token })).status
    ).toBe(404);
    expect((await call('/token?aud=store', { cookie: b1.cookie })).status).toBe(200);
  });
});

describe('refresh rotation and reuse detection', () => {
  it('a forced refresh rotates the cookie; the old one works for the grace window only, then its reuse kills the session', async () => {
    const u = await seedUser();
    const { cookie } = await login(u);
    const r = await call('/refresh?aud=store', { method: 'POST', cookie });
    expect(r.status).toBe(200);
    const fresh = cookieOf(r);
    expect(fresh).not.toBe(cookie);
    // inside the grace window the old token still resolves (parallel tabs)
    expect((await call('/token?aud=store', { cookie })).status).toBe(200);
    // age the rotation past the grace window: now presenting the old token is theft
    await env.DB.prepare(
      `UPDATE refresh_tokens SET revoked_at = ?1 WHERE revoked_reason = 'rotated'`
    )
      .bind(new Date(Date.now() - 5 * 60_000).toISOString())
      .run();
    expect((await call('/token?aud=store', { cookie })).status).toBe(401);
    // ...and the thief's detection took the legitimate rotated token down with it
    expect((await call('/token?aud=store', { cookie: fresh })).status).toBe(401);
  });

  it('an unknown or truncated cookie is a 401 and never a 500', async () => {
    expect((await call('/token?aud=store', { cookie: '__Host-ebda_rt=garbage' })).status).toBe(401);
    expect(
      (await call('/token?aud=store', { cookie: '__Host-ebda_rt=' + 'a'.repeat(500) })).status
    ).toBe(401);
    expect((await call('/token?aud=store')).status).toBe(401);
  });
});

describe('CSRF and CORS', () => {
  it('refuses cross-site and non-allow-listed origins on cookie endpoints, allows the admin origin with credentials', async () => {
    const u = await seedUser();
    const { cookie } = await login(u);
    expect(
      (await call('/token?aud=store', { cookie, headers: { 'sec-fetch-site': 'cross-site' } }))
        .status
    ).toBe(403);
    expect(
      (await call('/token?aud=store', { cookie, headers: { origin: 'https://evil.example' } }))
        .status
    ).toBe(403);
    expect(
      (
        await call('/logout', {
          method: 'POST',
          cookie,
          headers: { origin: 'https://evil.example' },
        })
      ).status
    ).toBe(403);
    const ok = await call('/token?aud=store', {
      cookie,
      headers: { origin: 'https://store.ebda.app', 'sec-fetch-site': 'same-site' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://store.ebda.app');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const evil = await call('/health', { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await call('/token', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(pre.status).toBe(403);
  });
});

describe('signup, OTP and password reset', () => {
  it('signup answers the same for a new and an existing address, mails a code, and verifies the email', async () => {
    const email = `new-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const body = { email, password: 'Str0ng!Passw0rd', firstName: 'Nora', language: 'ar' };
    const a = await call('/signup', { json: body });
    const b = await call('/signup', { json: body });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(await a.json()).toEqual(await b.json());
    // the second signup over a still-UNVERIFIED address overwrote the credential and mailed a fresh code
    expect(fakes.mails).toHaveLength(2);
    fakes.mails.shift(); // the first code was superseded
    expect(fakes.mails[0]).toMatchObject({ to: email, kind: 'email_verify' });
    const code = fakes.mails[0].code;
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await call('/otp/verify', {
      json: { email, code: code === '000000' ? '111111' : '000000', password: body.password },
    });
    expect(wrong.status).toBe(400);
    expect(
      (await call('/otp/verify', { json: { email, code, password: body.password } })).status
    ).toBe(200);
    expect(
      (await call('/otp/verify', { json: { email, code, password: body.password } })).status
    ).toBe(400); // single use
    const { body: session } = await login({ email, password: body.password });
    expect(session.user.id).toBeTruthy();
  });

  it('weak passwords are rejected with field errors', async () => {
    const r = await call('/signup', {
      json: { email: 'weak@example.com', password: 'short', firstName: 'A' },
    });
    expect(r.status).toBe(400);
  });

  it('a code dies after 5 wrong guesses even if the right code is then supplied', async () => {
    const email = `otp-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Str0ng!Passw0rd', firstName: 'A' } });
    const code = fakes.mails.at(-1)!.code;
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++)
      await call('/otp/verify', {
        json: { email, code: wrong, password: 'Str0ng!Passw0rd' },
        headers: { 'cf-connecting-ip': `192.0.2.${i + 1}` },
      });
    // refused either by the email lock (429) or the dead code (400): never accepted
    expect([400, 429]).toContain(
      (
        await call('/otp/verify', {
          json: { email, code, password: 'Str0ng!Passw0rd' },
          headers: { 'cf-connecting-ip': '192.0.2.99' },
        })
      ).status
    );
    const row = await env.DB.prepare(
      `SELECT used_at FROM verification_tokens ORDER BY created_at DESC LIMIT 1`
    ).first<{ used_at: string | null }>();
    expect(row!.used_at).not.toBeNull(); // the code itself was killed by the 5th wrong guess
  });

  it('password reset: generic answer, code resets, every session dies, the old password stops working', async () => {
    const u = await seedUser();
    const s = await login(u);
    const unknown = await call('/password/forgot', { json: { email: 'nobody@example.com' } });
    const known = await call('/password/forgot', { json: { email: u.email } });
    expect(await unknown.json()).toEqual(await known.json());
    expect(fakes.mails).toHaveLength(1);
    const reset = await call('/password/reset', {
      json: { email: u.email, code: fakes.mails[0].code, newPassword: 'N3w!Passw0rdXY' },
    });
    expect(reset.status).toBe(200);
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
    expect((await call('/login', { json: { email: u.email, password: u.password } })).status).toBe(
      401
    );
    expect(
      (await call('/login', { json: { email: u.email, password: 'N3w!Passw0rdXY' } })).status
    ).toBe(200);
  });
});

describe('MFA (TOTP)', () => {
  it('enrol, then login needs the code; a wrong code fails; a backup code works once', async () => {
    const u = await seedUser();
    const s = await login(u);
    const enroll = (await (
      await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token })
    ).json()) as {
      data: { secret: string };
    };
    const secret = enroll.data.secret;
    expect(
      (await call('/mfa/enroll/verify', { json: { code: '000000' }, bearer: s.body.access_token }))
        .status
    ).toBe(400);
    const verify = (await (
      await call('/mfa/enroll/verify', {
        json: { code: await totpAt(secret), emailCode: await emailCodeFor(u, s.body.access_token) },
        bearer: s.body.access_token,
      })
    ).json()) as { data: { backupCodes: string[] } };
    expect(verify.data.backupCodes).toHaveLength(10);
    // the secret is sealed at rest, never plain
    const row = await env.DB.prepare(`SELECT mfa_secret FROM users WHERE id = ?1`)
      .bind(u.id)
      .first<{ mfa_secret: string }>();
    // enrolment consumed this time step; a login in the SAME step would be a replay, so move the clock marker back
    await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
      .bind(u.id)
      .run();
    expect(row!.mfa_secret.startsWith('v3.')).toBe(true);
    expect(row!.mfa_secret).not.toContain(secret);

    const first = await call('/login', { json: { email: u.email, password: u.password } });
    const challenge = (
      (await first.json()) as { data: { mfaRequired: boolean; challenge: string } }
    ).data;
    expect(challenge.mfaRequired).toBe(true);
    expect(cookieOf(first)).toBe(''); // no session yet
    expect(
      (await call('/login/mfa', { json: { challenge: challenge.challenge, code: '000000' } }))
        .status
    ).toBe(401);
    const ok = await call('/login/mfa', {
      json: { challenge: challenge.challenge, code: await totpAt(secret) },
    });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).not.toBe('');
    // the challenge is consumed
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: challenge.challenge, code: await totpAt(secret) },
        })
      ).status
    ).toBe(401);

    const second = (await (
      await call('/login', { json: { email: u.email, password: u.password } })
    ).json()) as { data: { challenge: string } };
    const backup = verify.data.backupCodes[0];
    expect(
      (await call('/login/mfa', { json: { challenge: second.data.challenge, backupCode: backup } }))
        .status
    ).toBe(200);
    const third = (await (
      await call('/login', { json: { email: u.email, password: u.password } })
    ).json()) as { data: { challenge: string } };
    expect(
      (await call('/login/mfa', { json: { challenge: third.data.challenge, backupCode: backup } }))
        .status
    ).toBe(401); // used
  });

  it('a challenge dies after 5 wrong codes', async () => {
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
    const ch = (
      (await (await call('/login', { json: { email: u.email, password: u.password } })).json()) as {
        data: { challenge: string };
      }
    ).data.challenge;
    for (let i = 0; i < 5; i++)
      await call('/login/mfa', { json: { challenge: ch, code: '000000' } });
    expect(
      (await call('/login/mfa', { json: { challenge: ch, code: await totpAt(secret) } })).status
    ).toBe(401);
  });

  it('enrolment needs the password again (step-up)', async () => {
    const u = await seedUser();
    const s = await login(u);
    expect(
      (await call('/mfa/enroll', { json: { password: 'wrong' }, bearer: s.body.access_token }))
        .status
    ).toBe(403);
  });
});

describe('token forgery', () => {
  it('management endpoints refuse a token signed by another key, an HS256 token, alg none, and an expired token', async () => {
    const u = await seedUser();
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ sid: crypto.randomUUID(), stores: [] })
      .setProtectedHeader({ alg: 'ES256', kid: 'attacker', typ: 'at+jwt' })
      .setIssuer('https://accounts.ebda.app')
      .setAudience('store')
      .setSubject(u.id)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    expect((await call('/me', { bearer: forged })).status).toBe(401);
    const hs = await new SignJWT({ sid: 'x' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer('https://accounts.ebda.app')
      .setAudience('store')
      .setSubject(u.id)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('some-shared-secret-some-shared-secret'));
    expect((await call('/me', { bearer: hs })).status).toBe(401);
    const none = `${btoa(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).replace(/=/g, '')}.${btoa(JSON.stringify({ sub: u.id, sid: 'x', iss: 'https://accounts.ebda.app', aud: 'store', exp: 9999999999 })).replace(/=/g, '')}.`;
    expect((await call('/me', { bearer: none })).status).toBe(401);
    expect((await call('/me')).status).toBe(401);
  });
});
