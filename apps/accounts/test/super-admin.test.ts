/** Platform administrators (Ruling ID-15): CLI upsert, second factor required for `pa`, 12 h freshness. */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { call, fakes, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';
import { sha256Hex } from '../src/util';
import { hashPassword } from '../src/password';
import {
  buildUpsertSql,
  decide,
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

  async function enrolToken(userId: string, ttlMs = 30 * 60_000) {
    const token = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO enrolment_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?1,?2,?3,?4,?5)`
    )
      .bind(crypto.randomUUID(), userId, await sha256Hex(token), Date.now() + ttlMs, Date.now())
      .run();
    return token;
  }
  /** Request the e-mailed code the way the admin UI does, then return the code from the fake mailer. */
  async function emailedCode(u: { password: string }, bearer: string) {
    const before = fakes.mails.length;
    const r = await call('/mfa/bootstrap/code', { json: { password: u.password }, bearer });
    expect(r.status).toBe(202);
    expect(fakes.mails).toHaveLength(before + 1);
    expect(fakes.mails.at(-1)!.kind).toBe('factor_enrol');
    return fakes.mails.at(-1)!.code;
  }
  async function enrolWithProof(u: { id: string; password: string }, bearer: string) {
    const secret = (
      (await (await call('/mfa/enroll', { json: { password: u.password }, bearer })).json()) as {
        data: { secret: string };
      }
    ).data.secret;
    const enrolmentToken = await enrolToken(u.id);
    const emailCode = await emailedCode(u, bearer);
    const r = await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret), enrolmentToken, emailCode },
      bearer,
    });
    expect(r.status).toBe(200);
    return secret;
  }
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
    const secret = await enrolWithProof(u, s.body.access_token);
    await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
      .bind(u.id)
      .run();

    const first = (await (
      await call('/login', { json: { email: u.email, password: u.password } })
    ).json()) as { data: { mfaRequired: boolean; challenge: string; access_token?: string } };
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

describe('first-factor bootstrap for a platform admin (Ruling ID-15)', () => {
  const setup = async () => {
    const u = await seedUser({ role: 'super_admin' });
    const s = await login(u);
    return { u, bearer: s.body.access_token };
  };
  const token = async (userId: string, ttlMs = 30 * 60_000) => {
    const t = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO enrolment_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?1,?2,?3,?4,?5)`
    )
      .bind(crypto.randomUUID(), userId, await sha256Hex(t), Date.now() + ttlMs, Date.now())
      .run();
    return t;
  };
  const code = async (u: { password: string }, bearer: string) => {
    await call('/mfa/bootstrap/code', { json: { password: u.password }, bearer });
    return fakes.mails.at(-1)!.code;
  };
  const verify = async (secret: string, bearer: string, extra: Record<string, unknown>) => {
    // each attempt may reuse the same 30 s TOTP step: clear the replay marker so only the PROOF decides the outcome
    await env.DB.prepare(
      `UPDATE users SET mfa_last_step = NULL WHERE mfa_secret IS NOT NULL`
    ).run();
    return call('/mfa/enroll/verify', { json: { code: await totpAt(secret), ...extra }, bearer });
  };
  const begin = async (u: { password: string }, bearer: string) =>
    (
      (await (await call('/mfa/enroll', { json: { password: u.password }, bearer })).json()) as {
        data: { secret: string };
      }
    ).data.secret;
  const factorCount = async (id: string) =>
    (await env.DB.prepare(`SELECT mfa_enabled AS n FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ n: number }>())!.n;

  it('a password-only session with NO proof cannot bind a TOTP: refused, nothing enabled', async () => {
    const { u, bearer } = await setup();
    const secret = await begin(u, bearer);
    const r = await verify(secret, bearer, {});
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'ENROLMENT_PROOF_REQUIRED'
    );
    expect(await factorCount(u.id)).toBe(0);
  });

  it('a passkey cannot be registered without the proof either', async () => {
    const { bearer } = await setup();
    const r = await call('/passkey/register/verify', { json: { response: {} }, bearer });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'ENROLMENT_PROOF_REQUIRED'
    );
  });

  it('the operator token alone is not enough, and neither is the e-mailed code alone', async () => {
    const { u, bearer } = await setup();
    const secret = await begin(u, bearer);
    const t = await token(u.id);
    expect((await verify(secret, bearer, { enrolmentToken: t })).status).toBe(403);
    const c = await code(u, bearer);
    expect((await verify(secret, bearer, { emailCode: c })).status).toBe(403);
    expect(await factorCount(u.id)).toBe(0);
  });

  it('a wrong token or a wrong code is refused', async () => {
    const { u, bearer } = await setup();
    const secret = await begin(u, bearer);
    const c = await code(u, bearer);
    await token(u.id);
    expect(
      (await verify(secret, bearer, { enrolmentToken: 'not-the-token', emailCode: c })).status
    ).toBe(403);
    const t = await token(u.id);
    expect((await verify(secret, bearer, { enrolmentToken: t, emailCode: '000000' })).status).toBe(
      403
    );
    expect(await factorCount(u.id)).toBe(0);
  });

  it('both proofs enrol, and the token cannot be used a second time', async () => {
    const { u, bearer } = await setup();
    const secret = await begin(u, bearer);
    const t = await token(u.id);
    const ok = await verify(secret, bearer, {
      enrolmentToken: t,
      emailCode: await code(u, bearer),
    });
    expect(ok.status).toBe(200);
    expect(await factorCount(u.id)).toBe(1);
    // factor removed (as an operator reset would), the SAME used token must still fail
    await env.DB.prepare(`UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?1`)
      .bind(u.id)
      .run();
    const secret2 = await begin(u, bearer);
    await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(u.id).run();
    const again = await verify(secret2, bearer, {
      enrolmentToken: t,
      emailCode: await code(u, bearer),
    });
    expect(again.status).toBe(403);
    expect(await factorCount(u.id)).toBe(0);
  });

  it('an EXPIRED token fails', async () => {
    const { u, bearer } = await setup();
    const secret = await begin(u, bearer);
    const t = await token(u.id, -1000);
    const r = await verify(secret, bearer, { enrolmentToken: t, emailCode: await code(u, bearer) });
    expect(r.status).toBe(403);
    expect(await factorCount(u.id)).toBe(0);
  });

  it("another admin's token does not work for this account", async () => {
    const { u, bearer } = await setup();
    const other = await seedUser({ role: 'super_admin' });
    const secret = await begin(u, bearer);
    const t = await token(other.id);
    const r = await verify(secret, bearer, { enrolmentToken: t, emailCode: await code(u, bearer) });
    expect(r.status).toBe(403);
  });

  it('the e-mailed code is only for a super admin who still has no factor', async () => {
    const merchant = await seedUser();
    const m = await login(merchant);
    const r = await call('/mfa/bootstrap/code', {
      json: { password: merchant.password },
      bearer: m.body.access_token,
    });
    expect(r.status).toBe(409);
    const wrong = await setup();
    expect(
      (
        await call('/mfa/bootstrap/code', {
          json: { password: 'wrong-password' },
          bearer: wrong.bearer,
        })
      ).status
    ).toBe(403);
  });

  it('a merchant still enrols without any proof (the rule is for platform admins only)', async () => {
    const m = await seedUser();
    const s = await login(m);
    const secret = await begin(m, s.body.access_token);
    expect((await verify(secret, s.body.access_token, {})).status).toBe(200);
  });
});

describe('promotion clears old factors and issues the token', () => {
  const plant = async (userId: string) => {
    await env.DB.prepare(
      `UPDATE users SET mfa_enabled = 1, mfa_secret = 'planted', mfa_backup_codes = '["x"]' WHERE id = ?1`
    )
      .bind(userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, device_type, rp_id, name, created_at)
       VALUES (?1,?2,?3,'pk','singleDevice','store.ebda.app','planted',?4)`
    )
      .bind(crypto.randomUUID(), userId, `cred-${userId}`, new Date().toISOString())
      .run();
  };
  const upsert = async (id: string, email: string, resetFactors: boolean, role: string) => {
    const existing = await env.DB.prepare(lookupSql(email)).first<Record<string, unknown>>();
    const plan = decide(existing, resetFactors);
    const tokenHash = plan.issueToken ? await sha256Hex(crypto.randomUUID()) : null;
    await run(
      buildUpsertSql({
        existingId: id,
        newId: crypto.randomUUID(),
        email,
        passwordHash: await hashPassword('Another-Long-Pass-77!'),
        firstName: 'A',
        lastName: 'B',
        nowIso: new Date().toISOString(),
        nowMs: Date.now(),
        clearFactors: plan.clearFactors,
        tokenHash,
        tokenId: tokenHash ? crypto.randomUUID() : null,
      })
    );
    return { plan, tokenHash, role };
  };
  const state = async (id: string) => ({
    passkeys: (await env.DB.prepare(
      `SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`
    )
      .bind(id)
      .first<{ n: number }>())!.n,
    user: await env.DB.prepare(`SELECT role, mfa_enabled, mfa_secret FROM users WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>(),
    tokens: (
      await env.DB.prepare(`SELECT token_hash, expires_at FROM enrolment_tokens WHERE user_id = ?1`)
        .bind(id)
        .all()
    ).results as Array<{ token_hash: string; expires_at: number }>,
  });

  it('promoting a merchant who had a TOTP secret and a passkey wipes both and stores exactly one HASHED token', async () => {
    const u = await seedUser(); // store_admin
    await plant(u.id);
    const { plan, tokenHash } = await upsert(u.id, u.email, false, 'store_admin');
    expect(plan).toEqual({ clearFactors: true, issueToken: true });
    const st = await state(u.id);
    expect(st.user).toMatchObject({ role: 'super_admin', mfa_enabled: 0, mfa_secret: null });
    expect(st.passkeys).toBe(0);
    expect(st.tokens).toHaveLength(1);
    expect(st.tokens[0].token_hash).toBe(tokenHash);
    expect(st.tokens[0].token_hash).toMatch(/^[0-9a-f]{64}$/); // only a hash at rest
    expect(st.tokens[0].expires_at - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  });

  it('re-running for a super_admin who HAS a factor keeps it and issues no token; --reset-factors wipes it', async () => {
    const u = await seedUser({ role: 'super_admin' });
    await plant(u.id);
    const keep = await upsert(u.id, u.email, false, 'super_admin');
    expect(keep.plan).toEqual({ clearFactors: false, issueToken: false });
    expect((await state(u.id)).passkeys).toBe(1);
    expect((await state(u.id)).tokens).toHaveLength(0);
    const reset = await upsert(u.id, u.email, true, 'super_admin');
    expect(reset.plan).toEqual({ clearFactors: true, issueToken: true });
    expect((await state(u.id)).passkeys).toBe(0);
    expect((await state(u.id)).tokens).toHaveLength(1);
  });

  it('a super_admin with no factor gets a fresh token and the old one is invalidated', async () => {
    const u = await seedUser({ role: 'super_admin' });
    await upsert(u.id, u.email, false, 'super_admin');
    const first = (await state(u.id)).tokens[0].token_hash;
    await upsert(u.id, u.email, false, 'super_admin');
    const after = (await state(u.id)).tokens;
    expect(after).toHaveLength(1);
    expect(after[0].token_hash).not.toBe(first);
  });

  it('the dry-run text warns that factors will be deleted', () => {
    const lines = describePlan(
      { id: 'x', role: 'store_admin', status: 'active', mfa_enabled: 1, passkeys: 1 },
      'a@b.co'
    ).join('\n');
    expect(lines).toMatch(/WARNING: every existing TOTP secret/);
    expect(lines).toMatch(/ONE-TIME ENROLMENT TOKEN/);
  });
});
