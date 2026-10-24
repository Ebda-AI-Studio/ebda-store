/** Platform administrators (Ruling ID-15): CLI upsert, second factor required for `pa`, 12 h freshness. */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { call, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';
import { hashPassword } from '../src/password';
import {
  buildUpsertSql,
  describePlan,
  lookupSql,
  parseArgs,
  passwordProblem,
} from '../scripts/super-admin-sql.mjs';

const run = (statements: string[]) => env.DB.batch(statements.map(s => env.DB.prepare(s)));
const claims = (t: string) => decodeJwt(t) as Record<string, unknown>;

describe('upsert-super-admin CLI helpers', () => {
  it('dry run is the default and a password argument is refused outright', () => {
    expect(parseArgs(['--email=Boss@Example.com']).apply).toBe(false);
    expect(parseArgs(['--email=boss@example.com', '--apply']).apply).toBe(true);
    for (const a of ['--password=x', '--password', '--pass=x', '--pwd=x']) {
      expect(() => parseArgs(['--email=boss@example.com', a])).toThrow(
        /never be passed as an argument/
      );
    }
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["--email=a'b@example.com"])).toThrow();
  });

  it('enforces a 14-character password with all four classes', () => {
    expect(passwordProblem('short1!A')).toBeTruthy();
    expect(passwordProblem('alllowercase-no-digits!!')).toBeTruthy();
    expect(passwordProblem('Correct-Horse-Battery-9')).toBeNull();
  });

  it('refuses anything that is not a clean value before it can reach SQL', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-9');
    const base = {
      existingId: null,
      newId: crypto.randomUUID(),
      email: 'boss@example.com',
      passwordHash: hash,
      firstName: 'Ahmad',
      lastName: 'S',
      nowIso: new Date().toISOString(),
      nowMs: Date.now(),
    };
    expect(() => buildUpsertSql({ ...base, passwordHash: "x'; DROP TABLE users;--" })).toThrow();
    expect(() => buildUpsertSql({ ...base, email: "a'b@example.com" })).toThrow();
    expect(() => buildUpsertSql({ ...base, existingId: "1' OR '1'='1" })).toThrow();
    expect(() => lookupSql("x' OR 1=1 --@a.co")).toThrow();
  });

  it('CREATE: a new verified, active super_admin who can sign in with the typed password', async () => {
    const email = `boss-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const password = 'Correct-Horse-Battery-9';
    await run(
      buildUpsertSql({
        existingId: null,
        newId: crypto.randomUUID(),
        email,
        passwordHash: await hashPassword(password),
        firstName: 'Ahmad',
        lastName: 'Sharaf',
        nowIso: new Date().toISOString(),
        nowMs: Date.now(),
      })
    );
    const row = await env.DB.prepare(lookupSql(email)).first<{
      role: string;
      status: string;
      email_verified: number;
    }>();
    expect(row).toMatchObject({ role: 'super_admin', status: 'active', email_verified: 1 });
    expect((await login({ email, password })).res.status).toBe(200);
    expect(describePlan(null, email)[1]).toMatch(/CREATE/);
  });

  it('PROMOTE is idempotent: role, new password, verified, sessions ended; a second run changes nothing else', async () => {
    const u = await seedUser({ emailVerified: 0, status: 'inactive' });
    const old = await login(await seedUser()); // an unrelated user's session must survive
    const before = await login({
      email: (await seedUser({ emailVerified: 1 })).email,
      password: 'Str0ng!Passw0rd',
    });
    expect(old.res.status).toBe(200);
    expect(before.res.status).toBe(200);
    const target = await seedUser();
    const s = await login(target);
    const hash = await hashPassword('Another-Long-Pass-77!');
    const statements = () =>
      buildUpsertSql({
        existingId: target.id,
        newId: crypto.randomUUID(),
        email: target.email,
        passwordHash: hash,
        firstName: 'x',
        lastName: 'y',
        nowIso: new Date().toISOString(),
        nowMs: Date.now(),
      });
    await run(statements());
    await run(statements());
    const row = await env.DB.prepare(
      `SELECT role, status, email_verified, token_version FROM users WHERE id = ?1`
    )
      .bind(target.id)
      .first<{ role: string; status: string; email_verified: number }>();
    expect(row).toMatchObject({ role: 'super_admin', status: 'active', email_verified: 1 });
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401); // sessions ended
    expect(
      (await login({ email: target.email, password: 'Another-Long-Pass-77!' })).res.status
    ).toBe(200);
    expect(u.id).toBeTruthy();
    expect(old.res.status).toBe(200);
    expect(
      (await call('/token?aud=store', { cookie: old.cookie })).status // the unrelated session is untouched
    ).toBe(200);
  });
});

describe('super_admin power needs a second factor and a fresh login', () => {
  const makeAdmin = async () => {
    const u = await seedUser({ role: 'super_admin' });
    return u;
  };

  it('no second factor yet: the sign-in works but carries NO pa and says to enrol', async () => {
    const u = await makeAdmin();
    const s = await login(u);
    expect(s.res.status).toBe(200);
    const body = s.body as unknown as { access_token: string; mfaEnrollmentRequired?: boolean };
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(claims(body.access_token).pa).toBeUndefined();
    expect(claims(body.access_token).auth_time).toBeTypeOf('number');
  });

  it('after enrolling TOTP the password step is no longer enough; password + code mints pa with auth_time', async () => {
    const u = await makeAdmin();
    const s = await login(u);
    const secret = (
      (await (
        await call('/mfa/enroll', { json: { password: u.password }, bearer: s.body.access_token })
      ).json()) as {
        data: { secret: string };
      }
    ).data.secret;
    await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret) },
      bearer: s.body.access_token,
    });
    await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
      .bind(u.id)
      .run();

    const first = (await (
      await call('/login', { json: { email: u.email, password: u.password } })
    ).json()) as {
      data: { mfaRequired: boolean; challenge: string; access_token?: string };
    };
    expect(first.data.mfaRequired).toBe(true);
    expect(first.data.access_token).toBeUndefined(); // password alone yields nothing

    const done = (await (
      await call('/login/mfa', {
        json: { challenge: first.data.challenge, code: await totpAt(secret) },
      })
    ).json()) as { data: { access_token: string } };
    const c = claims(done.data.access_token);
    expect(c.pa).toBe('super_admin');
    expect(c.aud).toBe('store');
    expect(Math.abs((c.auth_time as number) - Date.now() / 1000)).toBeLessThan(30);
  });

  it('pa is minted only for a session created with a second factor (otp or passkey), never for password-only', async () => {
    const u = await makeAdmin();
    const s = await login(u);
    const sid = claims(s.body.access_token).sid as string;
    const token = async () =>
      (
        (await (await call('/token?aud=store', { cookie: s.cookie })).json()) as {
          data: { access_token: string };
        }
      ).data.access_token;
    expect(claims(await token()).pa).toBeUndefined();
    await env.DB.prepare(`UPDATE sessions SET amr = 'hwk' WHERE sid = ?1`).bind(sid).run();
    expect(claims(await token()).pa).toBe('super_admin');
    await env.DB.prepare(`UPDATE sessions SET amr = 'pwd,otp' WHERE sid = ?1`).bind(sid).run();
    expect(claims(await token()).pa).toBe('super_admin');
    await env.DB.prepare(`UPDATE sessions SET amr = 'pwd' WHERE sid = ?1`).bind(sid).run();
    expect(claims(await token()).pa).toBeUndefined();
  });

  it('a platform-admin session older than 12 h is refused with REAUTH_REQUIRED; a merchant session of the same age is not', async () => {
    const admin = await makeAdmin();
    const a = await login(admin);
    await env.DB.prepare(`UPDATE sessions SET created_at = ?2, amr = 'hwk' WHERE user_id = ?1`)
      .bind(admin.id, Date.now() - 13 * 3600_000)
      .run();
    const stale = await call('/token?aud=store', { cookie: a.cookie });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'REAUTH_REQUIRED'
    );

    const merchant = await seedUser();
    const m = await login(merchant);
    await env.DB.prepare(`UPDATE sessions SET created_at = ?2 WHERE user_id = ?1`)
      .bind(merchant.id, Date.now() - 13 * 3600_000)
      .run();
    expect((await call('/token?aud=store', { cookie: m.cookie })).status).toBe(200);
  });
});
