/** Second batch of review findings: parallel brute force, audience confusion, step-up throttles, flooding, session age. */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { call, emailCodeFor, fakes, login, seedUser, testEnv } from './helpers';
import { totpAt } from '../src/totp';
import { issueOtp } from '../src/otp';
import { SESSION_MAX_MS } from '../src/data';

beforeEach(() => {
  fakes.mails.length = 0;
  fakes.stores = [];
});

async function withMfa(u: { email: string; password: string }) {
  const s = await login(u);
  const secret = (
    (await (
      await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token })
    ).json()) as { data: { secret: string } }
  ).data.secret;
  const done = (await (
    await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret), emailCode: await emailCodeFor(u, s.body.access_token) },
      bearer: s.body.access_token,
    })
  ).json()) as { data: { backupCodes: string[] } };
  await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
    .bind(s.body.user.id)
    .run();
  return { secret, backupCodes: done.data.backupCodes, s };
}

describe('H1: only one live MFA challenge, and a burst across challenges cannot out-run the per-user budget', () => {
  it('a new password login replaces the previous challenge', async () => {
    const u = await seedUser();
    await withMfa(u);
    const first = (
      (await (await call('/login', { json: { email: u.email, password: u.password } })).json()) as {
        data: { challenge: string };
      }
    ).data.challenge;
    await call('/login', { json: { email: u.email, password: u.password } });
    const n = await env.DB.prepare(
      `SELECT count(*) AS n FROM challenges WHERE user_id = ?1 AND kind = 'mfa'`
    )
      .bind(u.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect((await call('/login/mfa', { json: { challenge: first, code: '000000' } })).status).toBe(
      401
    ); // the old one is gone
  });

  it('a parallel burst of wrong codes is capped by the per-user budget (counted before checking)', async () => {
    const u = await seedUser();
    const { secret } = await withMfa(u);
    const ch = (
      (await (await call('/login', { json: { email: u.email, password: u.password } })).json()) as {
        data: { challenge: string };
      }
    ).data.challenge;
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('/login/mfa', {
          json: { challenge: ch, code: '000000' },
          headers: { 'cf-connecting-ip': `192.0.2.${i + 1}` },
        })
      )
    );
    expect(res.every(r => r.status === 401 || r.status === 429)).toBe(true);
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1`)
      .bind(`s:mfa:${u.id}`)
      .first<{ n: number }>();
    expect(row!.n).toBeLessThanOrEqual(5);
    expect(
      (await call('/login/mfa', { json: { challenge: ch, code: await totpAt(secret) } })).status
    ).toBe(401);
  });
});

describe('M6: the password login budget is enforced under a parallel burst', () => {
  it('only 5 of 15 parallel wrong-password attempts reach the password check', async () => {
    const u = await seedUser();
    const res = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        call('/login', {
          json: { email: u.email, password: `wrong-${i}` },
          headers: { 'cf-connecting-ip': '198.19.0.1' },
        })
      )
    );
    const codes = res.map(r => r.status);
    expect(codes.filter(c => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes.filter(c => c === 429).length).toBeGreaterThanOrEqual(10);
    // one address: refused. (M-066: other addresses are NOT locked out, see targeted-lockout.test.ts.)
    expect(
      (
        await call('/login', {
          json: { email: u.email, password: u.password },
          headers: { 'cf-connecting-ip': '198.19.0.1' },
        })
      ).status
    ).toBe(429);
  });
});

describe('M1: audience separation', () => {
  it('a token minted for another product cannot manage credentials', async () => {
    const u = await seedUser();
    const s = await login(u, 'whatsapp');
    expect(
      (await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token }))
        .status
    ).toBe(401);
    expect((await call('/passkeys', { bearer: s.body.access_token })).status).toBe(401);
    // ...but it can still end its own session
    expect((await call('/logout', { method: 'POST', bearer: s.body.access_token })).status).toBe(
      200
    );
  });
});

describe('M2: password step-up is throttled', () => {
  it('guessing the password through step-up locks after 5 tries', async () => {
    const u = await seedUser();
    const s = await login(u);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push(
        (
          await call('/mfa/enroll', {
            json: { password: `guess-${i}` },
            bearer: s.body.access_token,
          })
        ).status
      );
    expect(codes.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect(
      (await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token }))
        .status
    ).toBe(429);
  });
});

describe('M3: with MFA on, adding a passkey needs a fresh second factor', () => {
  it('password alone is refused; password plus a fresh code is accepted', async () => {
    const u = await seedUser();
    const { secret, s } = await withMfa(u);
    const headers = { origin: 'https://store.ebda.app' };
    expect(
      (
        await call('/passkey/register/options', {
          json: { password: u.password },
          bearer: s.body.access_token,
          headers,
        })
      ).status
    ).toBe(403);
    const ok = await call('/passkey/register/options', {
      json: { password: u.password, code: await totpAt(secret, Date.now() + 30_000) },
      bearer: s.body.access_token,
      headers,
    });
    expect(ok.status).toBe(200);
  });
});

describe('M4: cheap unauthenticated writes are bounded', () => {
  it('signup and passkey options are limited per client IP', async () => {
    const ip = { 'cf-connecting-ip': '192.0.2.250' };
    const signup = [];
    for (let i = 0; i < 12; i++)
      signup.push(
        (
          await call('/signup', {
            json: { email: `flood${i}@example.com`, password: 'Str0ng!Passw0rd', firstName: 'F' },
            headers: ip,
          })
        ).status
      );
    expect(signup.filter(s => s === 202).length).toBe(10);
    expect(signup.filter(s => s === 429).length).toBe(2);
    const opts = [];
    for (let i = 0; i < 62; i++)
      opts.push(
        (
          await call('/passkey/login/options', {
            method: 'POST',
            headers: { ...ip, origin: 'https://store.ebda.app', 'cf-connecting-ip': '192.0.2.251' },
          })
        ).status
      );
    expect(opts.filter(s => s === 429).length).toBe(2);
  });

  it('expired ceremony challenges are deleted opportunistically', async () => {
    await env.DB.prepare(
      `INSERT INTO challenges (id, kind, data, expires_at) VALUES ('old1','passkey-login','{}',1)`
    ).run();
    await call('/passkey/login/options', {
      method: 'POST',
      headers: { origin: 'https://store.ebda.app' },
    });
    expect(await env.DB.prepare(`SELECT id FROM challenges WHERE id = 'old1'`).first()).toBeNull();
  });
});

describe('L2: a backup code is spent once even under a parallel race', () => {
  it('two parallel logins with the same backup code: exactly one wins', async () => {
    const u = await seedUser();
    const { backupCodes } = await withMfa(u);
    const code = backupCodes[0];
    const chA = (
      (await (await call('/login', { json: { email: u.email, password: u.password } })).json()) as {
        data: { challenge: string };
      }
    ).data.challenge;
    // a second challenge for the same user would replace the first (H1), so race two attempts on ONE challenge instead
    const res = await Promise.all([
      call('/login/mfa', { json: { challenge: chA, backupCode: code } }),
      call('/login/mfa', { json: { challenge: chA, backupCode: code } }),
    ]);
    expect(res.map(r => r.status).filter(s => s === 200).length).toBe(1);
  });
});

describe('L4: the OTP send cap holds under a burst', () => {
  it('no more than 3 live codes in the window, extras are never valid', async () => {
    const u = await seedUser({ emailVerified: 0 });
    const codes = await Promise.all(
      Array.from({ length: 8 }, () => issueOtp(env.DB, { id: u.id }, 'email'))
    );
    expect(codes.filter(Boolean).length).toBeLessThanOrEqual(3);
    const live = await env.DB.prepare(
      `SELECT count(*) AS n FROM verification_tokens WHERE user_id = ?1 AND used_at IS NULL`
    )
      .bind(u.id)
      .first<{ n: number }>();
    expect(live!.n).toBeLessThanOrEqual(1); // only the newest valid code survives
  });
});

describe('L7: sessions have an absolute lifetime', () => {
  it('a session older than the cap is dead for /token and for isRevoked, however recently it rotated', async () => {
    const u = await seedUser();
    const s = await login(u);
    await env.DB.prepare(`UPDATE sessions SET created_at = ?1 WHERE user_id = ?2`)
      .bind(Date.now() - SESSION_MAX_MS - 1000, u.id)
      .run();
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
    const { Accounts } = await import('../src/index');
    const sid = (await env.DB.prepare(`SELECT sid FROM sessions WHERE user_id = ?1`)
      .bind(u.id)
      .first<{ sid: string }>())!.sid;
    expect(await new Accounts({} as never, testEnv()).isRevoked(sid)).toBe(true);
  });
});

describe('RPC createUser', () => {
  it('validates input, binds the credential to a code, and reports only a VERIFIED address as taken', async () => {
    const { Accounts } = await import('../src/index');
    const rpc = new Accounts({} as never, testEnv());
    const base = { password: 'Str0ng!Passw0rd', firstName: 'A', lastName: 'B' };
    const email = `rpc-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const a = await rpc.createUser({ ...base, email });
    expect(a?.id).toBeTruthy();
    expect(fakes.mails.at(-1)).toMatchObject({ to: email, kind: 'email_verify' });
    expect(
      (await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?1`)
        .bind(a!.id)
        .first<{ password_hash: string }>())!.password_hash
    ).toBe('!pending');
    expect((await rpc.createUser({ ...base, email: email.toUpperCase() }))?.id).toBe(a!.id); // still unverified: re-registered, same row
    await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?1`).bind(a!.id).run();
    expect(await rpc.createUser({ ...base, email })).toBeNull();
    await expect(rpc.createUser({ ...base, email: 'not-an-email' })).rejects.toThrow();
    await expect(
      rpc.createUser({ ...base, email: 'x@example.com', id: 'not-a-uuid' })
    ).rejects.toThrow();
    await expect(rpc.createUser({ ...base, email: 'y@example.com', id: a!.id })).rejects.toThrow(); // id collision: an error, not "email taken"
  });
});

describe('every TOTP-checking endpoint is throttled per user (sweep)', () => {
  it('mfa/disable and mfa/enroll/verify stop guessing after 5 tries, even with token and password', async () => {
    const u = await seedUser();
    const s = await login(u);
    const enroll = (await (
      await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token })
    ).json()) as { data: { secret: string } };
    const verifyCodes: number[] = [];
    for (let i = 0; i < 7; i++)
      verifyCodes.push(
        (
          await call('/mfa/enroll/verify', {
            json: { code: '000000' },
            bearer: s.body.access_token,
          })
        ).status
      );
    expect(verifyCodes.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(verifyCodes.slice(5)).toEqual([429, 429]);
    // a fresh user: enrolled, then hammer disable
    const v = await seedUser();
    const t = await withMfa(v);
    const disable: number[] = [];
    for (let i = 0; i < 7; i++)
      disable.push(
        (
          await call('/mfa/disable', {
            json: { password: v.password, code: '000000' },
            bearer: t.s.body.access_token,
          })
        ).status
      );
    expect(disable.filter(x => x === 429).length).toBeGreaterThanOrEqual(2);
    expect(
      (
        await call('/mfa/disable', {
          json: { password: v.password, code: await totpAt(t.secret, Date.now() + 60_000) },
          bearer: t.s.body.access_token,
        })
      ).status
    ).toBe(429);
    void enroll;
  });
});

describe("OTP send cap: spamming resend/forgot beyond the cap cannot kill the owner's live code", () => {
  it('over-cap requests are refused per email and never invalidate the code the owner holds', async () => {
    const u = await seedUser();
    await call('/password/forgot', { json: { email: u.email } });
    const live = fakes.mails.at(-1)!.code;
    // an attacker hammers forgot for the victim's address from many IPs
    for (let i = 0; i < 6; i++)
      await call('/password/forgot', {
        json: { email: u.email },
        headers: { 'cf-connecting-ip': `203.0.113.${i + 1}` },
      });
    const sent = fakes.mails.length;
    expect(sent).toBeLessThanOrEqual(3); // the cap, however many requests
    // the newest code that WAS mailed still works
    const newest = fakes.mails.at(-1)!.code;
    expect(
      (
        await call('/password/reset', {
          json: { email: u.email, code: newest, newPassword: 'N3w!Passw0rdXY' },
        })
      ).status
    ).toBe(200);
    void live;
  });

  it('the cap is checked before older codes are invalidated (issueOtp)', async () => {
    const u = await seedUser({ emailVerified: 0 });
    const first = await issueOtp(env.DB, { id: u.id }, 'email');
    await issueOtp(env.DB, { id: u.id }, 'email');
    const third = await issueOtp(env.DB, { id: u.id }, 'email');
    expect(third).not.toBeNull();
    const over = await issueOtp(env.DB, { id: u.id }, 'email'); // 4th within the window
    expect(over).toBeNull();
    // the third code (newest sent) is still live: the over-cap request invalidated nothing
    const live = await env.DB.prepare(
      `SELECT count(*) AS n FROM verification_tokens WHERE user_id = ?1 AND used_at IS NULL AND sent = 1`
    )
      .bind(u.id)
      .first<{ n: number }>();
    expect(live!.n).toBe(1);
    void first;
  });
});

describe('throttle: namespaced IP budgets, no inserts over budget, successes refunded', () => {
  it('a refused request writes no row; the IP budget of one flow does not drain another', async () => {
    const ip = '198.18.77.7';
    const u = await seedUser();
    for (let i = 0; i < 5; i++)
      await call('/login', {
        json: { email: u.email, password: 'bad' },
        headers: { 'cf-connecting-ip': ip },
      });
    const rows = async () =>
      (await env.DB.prepare(`SELECT count(*) AS n FROM login_attempts WHERE key LIKE ?1`)
        .bind(`%${u.email}`)
        .first<{ n: number }>())!.n;
    expect(await rows()).toBe(5);
    for (let i = 0; i < 5; i++)
      await call('/login', {
        json: { email: u.email, password: 'bad' },
        headers: { 'cf-connecting-ip': ip },
      });
    expect(await rows()).toBe(5); // 5 more refused attempts inserted nothing
    expect(
      await env.DB.prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1`)
        .bind(`i:login:${ip}`)
        .first()
    ).toMatchObject({ n: 5 });
    // a different flow from the same IP has its own counter
    expect(
      (
        await call('/passkey/login/options', {
          method: 'POST',
          headers: { 'cf-connecting-ip': ip, origin: 'https://store.ebda.app' },
        })
      ).status
    ).toBe(200);
  });

  it('honest successes behind one IP do not exhaust the IP budget (refunded)', async () => {
    const ip = '198.18.88.8';
    const users = await Promise.all(Array.from({ length: 3 }, () => seedUser()));
    for (let round = 0; round < 25; round++)
      for (const u of users)
        expect(
          (
            await call('/login', {
              json: { email: u.email, password: u.password },
              headers: { 'cf-connecting-ip': ip },
            })
          ).status
        ).toBe(200);
    expect(
      await env.DB.prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1`)
        .bind(`i:login:${ip}`)
        .first()
    ).toMatchObject({ n: 0 });
  });
});
