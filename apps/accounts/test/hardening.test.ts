/** Regression tests for the Opus security review of the identity service (pre-hijacking, MFA races, login CSRF, TOTP replay). */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { call, emailCodeFor, cookieOf, fakes, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';
import { sha256Hex } from '../src/util';

beforeEach(() => {
  fakes.stores = [];
  fakes.mails.length = 0;
  fakes.directoryDown = false;
});

async function enrollMfa(u: { email: string; password: string }) {
  const s = await login(u);
  const secret = (
    (await (
      await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token })
    ).json()) as { data: { secret: string } }
  ).data.secret;
  // move to the next time step so enrolment's own code does not shadow the login codes below
  await call('/mfa/enroll/verify', {
    json: { code: await totpAt(secret), emailCode: await emailCodeFor(u, s.body.access_token) },
    bearer: s.body.access_token,
  });
  await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
    .bind(s.body.user.id)
    .run();
  return secret;
}

const startChallenge = async (u: { email: string; password: string }, ip = '203.0.113.7') => {
  const r = await call('/login', {
    json: { email: u.email, password: u.password },
    headers: { 'cf-connecting-ip': ip },
  });
  return ((await r.json()) as { data: { challenge: string } }).data.challenge;
};

describe('1. pre-hijacking: an unverified account is unusable and is stripped on verification', () => {
  it('a signed-up but unverified account cannot sign in: the credential does not exist until a code activates it', async () => {
    const email = `pre-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Attacker!Pass1', firstName: 'Mallory' } });
    const right = await call('/login', { json: { email, password: 'Attacker!Pass1' } });
    expect(right.status).toBe(401); // indistinguishable from a wrong password
    expect(cookieOf(right)).toBe('');
    const stored = await env.DB.prepare(`SELECT password_hash FROM users WHERE lower(email) = ?1`)
      .bind(email)
      .first<{ password_hash: string }>();
    expect(stored!.password_hash).toBe('!pending'); // never the submitted password
  });

  it('a verified-flag gate still refuses an unverified account that does hold a password hash', async () => {
    const u = await seedUser({ emailVerified: 0 });
    const r = await call('/login', { json: { email: u.email, password: u.password } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await call('/login', { json: { email: u.email, password: 'wrong' } })).status).toBe(
      401
    );
  });

  it('passkey registration and MFA enrolment need a verified address', async () => {
    const u = await seedUser();
    const s = await login(u);
    await env.DB.prepare(`UPDATE users SET email_verified = 0 WHERE id = ?1`).bind(u.id).run();
    const reg = await call('/passkey/register/options', {
      json: { password: u.password },
      bearer: s.body.access_token,
      headers: { origin: 'https://store.ebda.app' },
    });
    expect(reg.status).toBe(403);
    expect(
      (await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token }))
        .status
    ).toBe(403);
  });

  it('the first verification deletes planted passkeys and MFA and revokes every session', async () => {
    const u = await seedUser({ emailVerified: 0 });
    const planted = await env.DB.prepare(
      `INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?1,?2,?3,?4)`
    )
      .bind('planted-sid', u.id, Date.now(), Date.now() + 1e9)
      .run();
    void planted;
    await env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, rp_id, name, created_at) VALUES ('p1',?1,'cred-planted','AAAA',0,'singleDevice','store.ebda.app','Evil',?2)`
    )
      .bind(u.id, new Date().toISOString())
      .run();
    await env.DB.prepare(
      `UPDATE users SET mfa_enabled = 1, mfa_secret = 'v1.a.b', mfa_backup_codes = '["x"]' WHERE id = ?1`
    )
      .bind(u.id)
      .run();
    await call('/otp/resend', { json: { email: u.email } });
    expect(
      (
        await call('/otp/verify', {
          json: { email: u.email, code: fakes.mails.at(-1)!.code, password: u.password },
        })
      ).status
    ).toBe(200);
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`)
        .bind(u.id)
        .first<{ n: number }>())!.n
    ).toBe(0);
    const row = await env.DB.prepare(
      `SELECT mfa_enabled, mfa_secret, mfa_backup_codes, email_verified FROM users WHERE id = ?1`
    )
      .bind(u.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      mfa_enabled: 0,
      mfa_secret: null,
      mfa_backup_codes: '[]',
      email_verified: 1,
    });
    const sess = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE sid = 'planted-sid'`
    ).first<{ revoked_at: number | null }>();
    expect(sess!.revoked_at).not.toBeNull();
  });

  it('a later verification of an already verified account does not strip its factors', async () => {
    const u = await seedUser();
    await env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, rp_id, name, created_at) VALUES ('p2',?1,'cred-real','AAAA',0,'singleDevice','store.ebda.app','Mine',?2)`
    )
      .bind(u.id, new Date().toISOString())
      .run();
    await call('/otp/resend', { json: { email: u.email } }); // verified accounts get no code
    expect(fakes.mails).toHaveLength(0);
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`)
        .bind(u.id)
        .first<{ n: number }>())!.n
    ).toBe(1);
  });

  it('a password reset of a VERIFIED account ends its sessions but keeps its passkeys and MFA (a mailbox alone must not bypass them)', async () => {
    const u = await seedUser();
    const s = await login(u);
    await env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, rp_id, name, created_at) VALUES ('p3',?1,'cred-x','AAAA',0,'singleDevice','store.ebda.app','Old',?2)`
    )
      .bind(u.id, new Date().toISOString())
      .run();
    await env.DB.prepare(`UPDATE users SET mfa_enabled = 1, mfa_secret = 'v1.a.b' WHERE id = ?1`)
      .bind(u.id)
      .run();
    await call('/password/forgot', { json: { email: u.email } });
    const r = await call('/password/reset', {
      json: { email: u.email, code: fakes.mails.at(-1)!.code, newPassword: 'N3w!Passw0rdXY' },
    });
    expect(r.status).toBe(200);
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401); // sessions gone
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`)
        .bind(u.id)
        .first<{ n: number }>())!.n
    ).toBe(1);
    expect(
      await env.DB.prepare(`SELECT mfa_enabled FROM users WHERE id = ?1`).bind(u.id).first()
    ).toMatchObject({ mfa_enabled: 1 });
    // ...and the new password still meets the second factor
    const next = await call('/login', { json: { email: u.email, password: 'N3w!Passw0rdXY' } });
    expect(((await next.json()) as { data: { mfaRequired?: boolean } }).data.mfaRequired).toBe(
      true
    );
  });

  it('a password reset of a never-verified account strips everything planted on it', async () => {
    const u = await seedUser({ emailVerified: 0 });
    await env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, rp_id, name, created_at) VALUES ('p4',?1,'cred-y','AAAA',0,'singleDevice','store.ebda.app','Evil',?2)`
    )
      .bind(u.id, new Date().toISOString())
      .run();
    await env.DB.prepare(`UPDATE users SET mfa_enabled = 1, mfa_secret = 'v1.a.b' WHERE id = ?1`)
      .bind(u.id)
      .run();
    await call('/password/forgot', { json: { email: u.email } });
    expect(
      (
        await call('/password/reset', {
          json: { email: u.email, code: fakes.mails.at(-1)!.code, newPassword: 'N3w!Passw0rdXY' },
        })
      ).status
    ).toBe(200);
    expect(
      (await env.DB.prepare(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`)
        .bind(u.id)
        .first<{ n: number }>())!.n
    ).toBe(0);
    expect(
      await env.DB.prepare(`SELECT mfa_enabled FROM users WHERE id = ?1`).bind(u.id).first()
    ).toMatchObject({ mfa_enabled: 0 });
  });

  it('verifying code X activates ONLY the password submitted with the signup that produced X (attacker first, victim second)', async () => {
    const email = `pre2-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Attacker!Pass1', firstName: 'Mallory' } });
    const attackerCode = fakes.mails.at(-1)!.code;
    await call('/signup', { json: { email, password: 'Victim!Pass123', firstName: 'Victoria' } });
    const victimCode = fakes.mails.at(-1)!.code;
    expect(victimCode).not.toBe(attackerCode);
    // the attacker's earlier code was superseded: it does nothing
    expect(
      (
        await call('/otp/verify', {
          json: { email, code: attackerCode, password: 'Attacker!Pass1' },
        })
      ).status
    ).toBe(400);
    expect(
      (await call('/otp/verify', { json: { email, code: victimCode, password: 'Victim!Pass123' } }))
        .status
    ).toBe(200);
    expect((await call('/login', { json: { email, password: 'Attacker!Pass1' } })).status).toBe(
      401
    );
    expect((await call('/login', { json: { email, password: 'Victim!Pass123' } })).status).toBe(
      200
    );
  });

  it("...and the reverse order: victim first, attacker second, the newest code activates the attacker's password only", async () => {
    const email = `pre3-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Victim!Pass123', firstName: 'Victoria' } });
    await call('/signup', { json: { email, password: 'Attacker!Pass1', firstName: 'Mallory' } });
    const newest = fakes.mails.at(-1)!.code;
    // the owner opens the newest mail (it carries the ATTACKER's pending credential): their own password does not activate it
    expect(
      (await call('/otp/verify', { json: { email, code: newest, password: 'Victim!Pass123' } }))
        .status
    ).toBe(400);
    expect(
      await env.DB.prepare(`SELECT email_verified FROM users WHERE lower(email) = ?1`)
        .bind(email)
        .first()
    ).toMatchObject({ email_verified: 0 });
    expect((await call('/login', { json: { email, password: 'Attacker!Pass1' } })).status).toBe(
      401
    ); // nothing was activated
    // the attacker can only activate it with a code that only the mailbox holder can read; with the code AND their password it works
    expect(
      (await call('/otp/verify', { json: { email, code: newest, password: 'Attacker!Pass1' } }))
        .status
    ).toBe(200);
    expect((await call('/login', { json: { email, password: 'Victim!Pass123' } })).status).toBe(
      401
    );
    expect((await call('/login', { json: { email, password: 'Attacker!Pass1' } })).status).toBe(
      200
    );
  });

  it("victim signs up, attacker re-signs: the victim's old code verifies with NOBODY's password, and the attacker's newest code does not verify with the victim's password", async () => {
    const email = `pre7-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Victim!Pass123', firstName: 'Victoria' } });
    const victimCode = fakes.mails.at(-1)!.code;
    await call('/signup', { json: { email, password: 'Attacker!Pass1', firstName: 'Mallory' } });
    const attackerCode = fakes.mails.at(-1)!.code;
    expect(attackerCode).not.toBe(victimCode);
    const verify = (code: string, password: string) =>
      call('/otp/verify', { json: { email, code, password } });
    // the victim's code was superseded: dead with their own password and with the attacker's
    expect((await verify(victimCode, 'Victim!Pass123')).status).toBe(400);
    expect((await verify(victimCode, 'Attacker!Pass1')).status).toBe(400);
    // the attacker's code (mailed to the VICTIM's inbox) does not activate under the victim's password
    expect((await verify(attackerCode, 'Victim!Pass123')).status).toBe(400);
    expect(
      await env.DB.prepare(`SELECT email_verified FROM users WHERE lower(email) = ?1`)
        .bind(email)
        .first()
    ).toMatchObject({ email_verified: 0 });
    // and neither password can sign in: nothing was activated
    expect((await call('/login', { json: { email, password: 'Victim!Pass123' } })).status).toBe(
      401
    );
    expect((await call('/login', { json: { email, password: 'Attacker!Pass1' } })).status).toBe(
      401
    );
  });

  it("the takeover path from the review: victim signs up, attacker signs up, victim resends and verifies with their own password -> never the attacker's", async () => {
    const email = `pre6-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Victim!Pass123', firstName: 'Victoria' } });
    await call('/signup', { json: { email, password: 'Attacker!Pass1', firstName: 'Mallory' } });
    await call('/otp/resend', { json: { email } }); // copies the latest signup's credential
    const code = fakes.mails.at(-1)!.code;
    expect(
      (await call('/otp/verify', { json: { email, code, password: 'Victim!Pass123' } })).status
    ).toBe(400);
    expect(
      await env.DB.prepare(
        `SELECT email_verified, password_hash FROM users WHERE lower(email) = ?1`
      )
        .bind(email)
        .first()
    ).toMatchObject({
      email_verified: 0,
      password_hash: '!pending',
    });
    // the owner's recovery: wait out the send window (3 codes per 15 minutes), then sign up again with their own password
    await env.DB.prepare(
      `UPDATE verification_tokens SET created_at = ?1 WHERE user_id = (SELECT id FROM users WHERE lower(email) = ?2)`
    )
      .bind(new Date(Date.now() - 20 * 60_000).toISOString(), email)
      .run();
    await env.DB.prepare(`DELETE FROM login_attempts`).run();
    await call('/signup', {
      json: { email, password: 'Victim!Pass123', firstName: 'Victoria' },
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
    const fresh = fakes.mails.at(-1)!.code;
    expect(
      (await call('/otp/verify', { json: { email, code: fresh, password: 'Victim!Pass123' } }))
        .status
    ).toBe(200);
    expect((await call('/login', { json: { email, password: 'Victim!Pass123' } })).status).toBe(
      200
    );
    expect((await call('/login', { json: { email, password: 'Attacker!Pass1' } })).status).toBe(
      401
    );
  });

  it('an unauthenticated signup never changes a stored credential, and a verified account is never touched', async () => {
    const u = await seedUser();
    const before = await env.DB.prepare(`SELECT password_hash, first_name FROM users WHERE id = ?1`)
      .bind(u.id)
      .first();
    await call('/signup', {
      json: { email: u.email, password: 'Third!Pass12345', firstName: 'X' },
    });
    expect(fakes.mails).toHaveLength(0);
    expect(
      await env.DB.prepare(`SELECT password_hash, first_name FROM users WHERE id = ?1`)
        .bind(u.id)
        .first()
    ).toEqual(before);
    // an UNVERIFIED row keeps its stored (unusable) credential too; the signup only adds a pending code
    const email = `pre4-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Attacker!Pass1', firstName: 'A' } });
    await call('/signup', { json: { email, password: 'Victim!Pass123', firstName: 'V' } });
    const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE lower(email) = ?1`)
      .bind(email)
      .first<{ password_hash: string }>();
    expect(row!.password_hash).toBe('!pending');
  });

  it('a resend carries the credential of the latest signup', async () => {
    const email = `pre5-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await call('/signup', { json: { email, password: 'Victim!Pass123', firstName: 'V' } });
    await call('/otp/resend', { json: { email } });
    const code = fakes.mails.at(-1)!.code;
    expect(
      (await call('/otp/verify', { json: { email, code, password: 'Victim!Pass123' } })).status
    ).toBe(200);
    expect((await call('/login', { json: { email, password: 'Victim!Pass123' } })).status).toBe(
      200
    );
  });
});

describe('2. MFA brute force: atomic attempt counter and a per-user budget', () => {
  it('parallel wrong guesses on one challenge are capped at 5 in total, then the right code is dead', async () => {
    const u = await seedUser();
    const secret = await enrollMfa(u);
    const ch = await startChallenge(u);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        call('/login/mfa', {
          json: { challenge: ch, code: '000000' },
          headers: { 'cf-connecting-ip': '192.0.2.77' },
        })
      )
    );
    void results;
    const row = await env.DB.prepare(`SELECT attempts FROM challenges WHERE id = ?1`)
      .bind(await sha256Hex(ch))
      .first<{ attempts: number }>();
    expect(row!.attempts).toBe(5); // never 6+: the increment is a guarded UPDATE
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: ch, code: await totpAt(secret) },
          headers: { 'cf-connecting-ip': '192.0.2.78' },
        })
      ).status
    ).toBe(401);
  });

  it('a fresh challenge does not reset the per-user budget: 5 failures across challenges lock the second factor', async () => {
    const u = await seedUser();
    const secret = await enrollMfa(u);
    for (let i = 0; i < 5; i++) {
      const ch = await startChallenge(u, `192.0.2.${100 + i}`);
      await call('/login/mfa', {
        json: { challenge: ch, code: '000000' },
        headers: { 'cf-connecting-ip': `192.0.2.${100 + i}` },
      });
    }
    const fresh = await startChallenge(u, '192.0.2.200');
    const res = await call('/login/mfa', {
      json: { challenge: fresh, code: await totpAt(secret) },
      headers: { 'cf-connecting-ip': '192.0.2.201' },
    });
    expect(res.status).toBe(429);
  });

  it('a successful second factor clears the per-user budget', async () => {
    const u = await seedUser();
    const secret = await enrollMfa(u);
    for (let i = 0; i < 3; i++) {
      const ch = await startChallenge(u, `192.0.2.${110 + i}`);
      await call('/login/mfa', {
        json: { challenge: ch, code: '000000' },
        headers: { 'cf-connecting-ip': `192.0.2.${110 + i}` },
      });
    }
    const ch = await startChallenge(u, '192.0.2.150');
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: ch, code: await totpAt(secret) },
          headers: { 'cf-connecting-ip': '192.0.2.150' },
        })
      ).status
    ).toBe(200);
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1`)
      .bind(`s:mfa:${u.id}`)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe('3. login CSRF: every state-changing endpoint needs an allowed origin and JSON', () => {
  it('login from another site or origin is refused, a form post is refused, the real origin works', async () => {
    const u = await seedUser();
    const body = { email: u.email, password: u.password };
    expect(
      (await call('/login', { json: body, headers: { 'sec-fetch-site': 'cross-site' } })).status
    ).toBe(403);
    expect(
      (await call('/login', { json: body, headers: { origin: 'https://evil.example' } })).status
    ).toBe(403);
    const form = await call('/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://store.ebda.app' },
      body: JSON.stringify(body),
    } as never);
    expect(form.status).toBe(415);
    const ok = await call('/login', {
      json: body,
      headers: { origin: 'https://store.ebda.app', 'sec-fetch-site': 'same-site' },
    });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).not.toBe('');
  });

  it('MFA verify, passkey sign-in, refresh, logout, signup and reset all refuse a hostile origin', async () => {
    const evil = { origin: 'https://evil.example' };
    for (const [path, json] of [
      ['/login/mfa', { challenge: 'x'.repeat(20), code: '000000' }],
      ['/passkey/login/verify', { response: {} }],
      ['/refresh', undefined],
      ['/logout', undefined],
      ['/signup', { email: 'a@example.com', password: 'Str0ng!Passw0rd', firstName: 'A' }],
      [
        '/password/reset',
        { email: 'a@example.com', code: '123456', newPassword: 'Str0ng!Passw0rd' },
      ],
      ['/otp/verify', { email: 'a@example.com', code: '123456', password: 'x' }],
    ] as const) {
      const r = await call(
        path,
        json ? { json, headers: evil } : { method: 'POST', headers: evil }
      );
      expect([path, r.status]).toEqual([path, 403]);
    }
  });
});

describe('4. TOTP replay', () => {
  it('a code that was accepted once is refused the second time, even inside its window', async () => {
    const u = await seedUser();
    const secret = await enrollMfa(u);
    const code = await totpAt(secret);
    const c1 = await startChallenge(u, '192.0.2.31');
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: c1, code },
          headers: { 'cf-connecting-ip': '192.0.2.31' },
        })
      ).status
    ).toBe(200);
    const c2 = await startChallenge(u, '192.0.2.32');
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: c2, code },
          headers: { 'cf-connecting-ip': '192.0.2.32' },
        })
      ).status
    ).toBe(401);
  });

  it('two parallel logins with the same code: exactly one wins', async () => {
    const u = await seedUser();
    const secret = await enrollMfa(u);
    const code = await totpAt(secret);
    const [a, b] = await Promise.all([
      startChallenge(u, '192.0.2.41'),
      startChallenge(u, '192.0.2.42'),
    ]);
    const res = await Promise.all([
      call('/login/mfa', {
        json: { challenge: a, code },
        headers: { 'cf-connecting-ip': '192.0.2.41' },
      }),
      call('/login/mfa', {
        json: { challenge: b, code },
        headers: { 'cf-connecting-ip': '192.0.2.42' },
      }),
    ]);
    expect(res.map(r => r.status).sort()).toEqual([200, 401]);
  });

  it('an older step than the last accepted one is refused', async () => {
    const u = await seedUser();
    const secret = await enrollMfa(u);
    const now = Date.now();
    const newer = await totpAt(secret, now);
    const older = await totpAt(secret, now - 30_000);
    const c1 = await startChallenge(u, '192.0.2.51');
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: c1, code: newer },
          headers: { 'cf-connecting-ip': '192.0.2.51' },
        })
      ).status
    ).toBe(200);
    const c2 = await startChallenge(u, '192.0.2.52');
    expect(
      (
        await call('/login/mfa', {
          json: { challenge: c2, code: older },
          headers: { 'cf-connecting-ip': '192.0.2.52' },
        })
      ).status
    ).toBe(401);
  });
});

describe('HSTS (Ruling HSTS-ALL-1)', () => {
  const HSTS = 'max-age=31536000; includeSubDomains; preload';
  it.each(['/health', '/login', '/nope', '/.well-known/jwks.json'])(
    '%s carries the same HSTS policy as the other hosts',
    async path => {
      const r = await call(
        path,
        path === '/login' ? { json: { email: 'a@b.co', password: 'x' } } : {}
      );
      expect(r.headers.get('strict-transport-security')).toBe(HSTS);
    }
  );
  it('a studio 404 page carries it too', async () => {
    const r = await call('/nope', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(404);
    expect(r.headers.get('strict-transport-security')).toBe(HSTS);
  });
});
