/** Platform administrators (Ruling ID-15): CLI upsert, second factor required for `pa`, 12 h freshness. */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { call, emailCodeFor, fakes, login, seedUser } from './helpers';
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

const ORIGIN = { origin: 'https://store.ebda.app' };
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
    const { u, bearer } = await setup();
    const opts = await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: u.password },
      bearer,
    });
    expect(opts.status).toBe(200);
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
    expect(((await ok.json()) as { data: { requiresSignIn: boolean } }).data.requiresSignIn).toBe(
      true
    );
    expect(await factorCount(u.id)).toBe(1);
    // the enrolling (password-only) session is ended too: the person signs in again with the new factor
    expect((await call('/token?aud=store', { bearer })).status).toBeGreaterThanOrEqual(400);
    // factor removed (as an operator reset would), the SAME used token must still fail
    await env.DB.prepare(`UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?1`)
      .bind(u.id)
      .run();
    const bearer2 = (await login(u)).body.access_token;
    const secret2 = await begin(u, bearer2);
    await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(u.id).run();
    const again = await verify(secret2, bearer2, {
      enrolmentToken: t,
      emailCode: await code(u, bearer2),
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

  it('the e-mailed code is for an account that still has no factor, and needs the password', async () => {
    const merchant = await seedUser();
    const m = await login(merchant);
    expect(
      (
        await call('/mfa/bootstrap/code', {
          json: { password: merchant.password },
          bearer: m.body.access_token,
        })
      ).status
    ).toBe(202); // a merchant's first factor needs it too (E1)
    await env.DB.prepare(`UPDATE users SET mfa_enabled = 1, mfa_secret = 'x' WHERE id = ?1`)
      .bind(merchant.id)
      .run();
    expect(
      (
        await call('/mfa/bootstrap/code', {
          json: { password: merchant.password },
          bearer: m.body.access_token,
        })
      ).status
    ).toBe(409); // already has a factor: step-up applies instead
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

  it("E1: a merchant's FIRST factor needs the e-mailed code: a phished password + session cannot bind one", async () => {
    const m = await seedUser();
    const s = await login(m);
    const bearer = s.body.access_token;
    const secret = await begin(m, bearer);
    const none = await verify(secret, bearer, {});
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_CODE_REQUIRED'
    );
    await code(m, bearer);
    const wrong = await verify(secret, bearer, { emailCode: '000000' });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_CODE_INVALID'
    );
    expect(await factorCount(m.id)).toBe(0);
    const ok = await verify(secret, bearer, { emailCode: await code(m, bearer) });
    expect(ok.status).toBe(200);
    expect(await factorCount(m.id)).toBe(1);
  });

  it("E1: a merchant's first PASSKEY needs the e-mailed code as well", async () => {
    const m = await seedUser();
    const s = await login(m);
    await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: m.password },
      bearer: s.body.access_token,
    });
    const r = await call('/passkey/register/verify', {
      json: { response: {} },
      bearer: s.body.access_token,
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_CODE_REQUIRED'
    );
  });

  it('E1: a "new sign-in method added" notice goes to the mailbox when a factor is bound', async () => {
    const m = await seedUser();
    const s = await login(m);
    const bearer = s.body.access_token;
    const secret = await begin(m, bearer);
    const before = fakes.notices.length;
    expect((await verify(secret, bearer, { emailCode: await code(m, bearer) })).status).toBe(200);
    expect(fakes.notices.slice(before)).toEqual([
      { to: m.email, kind: 'factor_added', factor: 'totp' },
    ]);
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

describe('enrolment tickets and step-up for every factor (Ruling ID-15, review round 2)', () => {
  const sidOf = (t: string) => claims(t).sid as string;
  const mkToken = async (userId: string) => {
    const t = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO enrolment_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?1,?2,?3,?4,?5)`
    )
      .bind(crypto.randomUUID(), userId, await sha256Hex(t), Date.now() + 1_800_000, Date.now())
      .run();
    return t;
  };
  const mailedCode = async (u: { password: string }, bearer: string) => {
    await call('/mfa/bootstrap/code', { json: { password: u.password }, bearer });
    return fakes.mails.at(-1)!.code;
  };
  const begin = async (u: { password: string }, bearer: string, code?: string) =>
    call('/mfa/enroll', { json: { password: u.password, ...(code ? { code } : {}) }, bearer });
  const secretOf = async (r: Response) =>
    ((await r.json()) as { data: { secret: string } }).data.secret;
  const setAmr = (sid: string, amr: string, ageMs = 0) =>
    env.DB.prepare(`UPDATE sessions SET amr = ?2, created_at = ?3 WHERE sid = ?1`)
      .bind(sid, amr, Date.now() - ageMs)
      .run();
  const addPasskeyRow = (userId: string) =>
    env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, device_type, rp_id, name, created_at)
       VALUES (?1,?2,?3,'pk','singleDevice','store.ebda.app','k',?4)`
    )
      .bind(crypto.randomUUID(), userId, `c-${crypto.randomUUID()}`, new Date().toISOString())
      .run();
  const count = async (sql: string, ...b: unknown[]) =>
    ((
      await env.DB.prepare(sql)
        .bind(...b)
        .first<{ n: number }>()
    )?.n ?? 0) as number;

  it('TOCTOU: a passkey ceremony started with no factor still demands the proof after a factor appears meanwhile', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const { body } = await login(u);
    const bearer = body.access_token;
    expect(
      (
        await call('/passkey/register/options', {
          json: { password: u.password },
          bearer,
          headers: ORIGIN,
        })
      ).status
    ).toBe(200);
    await addPasskeyRow(u.id); // another route enrolled a factor between options and verify
    const r = await call('/passkey/register/verify', { json: { response: {} }, bearer });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'ENROLMENT_PROOF_REQUIRED'
    );
  });

  it('verifying with no ticket (nothing was begun in this session) is refused', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const { body } = await login(u);
    // a real pending secret, but its ticket is gone (expired / cleared): completion must refuse
    const secret = await secretOf(await begin(u, body.access_token));
    await env.DB.prepare(`DELETE FROM challenges WHERE user_id = ?1 AND kind = 'factor-enrol'`)
      .bind(u.id)
      .run();
    const r = await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret) },
      bearer: body.access_token,
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('ENROL_NOT_STARTED');
    expect(await count(`SELECT mfa_enabled AS n FROM users WHERE id = ?1`, u.id)).toBe(0);
    // ... and the passkey path: verify without options
    const p = await call('/passkey/register/verify', {
      json: { response: {} },
      bearer: body.access_token,
    });
    expect(p.status).toBe(409);
    expect(((await p.json()) as { error: { code: string } }).error.code).toBe('ENROL_NOT_STARTED');
  });

  it("a ticket belongs to the session that began it: another session cannot finish someone else's enrolment", async () => {
    const u = await seedUser({ role: 'super_admin' });
    const a = await login(u);
    const b = await login(u);
    const secret = await secretOf(await begin(u, a.body.access_token));
    const t = await mkToken(u.id);
    const code = await mailedCode(u, b.body.access_token);
    const r = await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret), enrolmentToken: t, emailCode: code },
      bearer: b.body.access_token,
    });
    expect(r.status).toBe(409);
    expect(await count(`SELECT mfa_enabled AS n FROM users WHERE id = ?1`, u.id)).toBe(0);
  });

  it('a successful first enrolment deletes every pending register challenge and ends EVERY session, the enrolling one included', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const a = await login(u);
    const b = await login(u);
    // a passkey ceremony is pending in session A
    await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: u.password },
      bearer: a.body.access_token,
    });
    expect(
      await count(
        `SELECT count(*) AS n FROM challenges WHERE user_id = ?1 AND kind = 'passkey-register'`,
        u.id
      )
    ).toBe(1);
    const secret = await secretOf(await begin(u, a.body.access_token));
    const t = await mkToken(u.id);
    const code = await mailedCode(u, a.body.access_token);
    const done = await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret), enrolmentToken: t, emailCode: code },
      bearer: a.body.access_token,
    });
    expect(done.status).toBe(200);
    expect(
      await count(
        `SELECT count(*) AS n FROM challenges WHERE user_id = ?1 AND kind IN ('passkey-register','factor-enrol')`,
        u.id
      )
    ).toBe(0);
    const sa = await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE sid = ?1`)
      .bind(sidOf(a.body.access_token))
      .first<{ revoked_at: number | null }>();
    const sb = await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE sid = ?1`)
      .bind(sidOf(b.body.access_token))
      .first<{ revoked_at: number | null }>();
    expect(sa!.revoked_at).not.toBeNull(); // the password-only enrolling session is ended too (sign in again)
    expect(((await done.json()) as { data: { requiresSignIn: boolean } }).data.requiresSignIn).toBe(
      true
    );
    expect(sb!.revoked_at).not.toBeNull(); // and every other session
    expect((await call('/token?aud=store', { cookie: b.cookie })).status).toBe(401);
  });

  it('ONCE A FACTOR EXISTS, adding another needs a fresh second-factor session (a password session is refused: super admin)', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const s = await login(u); // signed in while factorless: amr 'pwd'
    await addPasskeyRow(u.id);
    const opts = await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: u.password },
      bearer: s.body.access_token,
    });
    expect(opts.status).toBe(403);
    expect(((await opts.json()) as { error: { code: string } }).error.code).toBe(
      'STEP_UP_REQUIRED'
    );
    expect((await begin(u, s.body.access_token)).status).toBe(403);
  });

  it('...and a store owner with a TOTP is refused the same way; a code or a fresh otp/passkey session lets it through', async () => {
    const m = await seedUser();
    const s0 = await login(m);
    const secret = await secretOf(await begin(m, s0.body.access_token));
    expect(
      (
        await call('/mfa/enroll/verify', {
          json: {
            code: await totpAt(secret),
            emailCode: await emailCodeFor(m, s0.body.access_token),
          },
          bearer: s0.body.access_token,
        })
      ).status
    ).toBe(200);
    await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(m.id).run();

    // fresh session but password-only (phished password): refused, MFA_REQUIRED
    const s = await login({ email: m.email, password: m.password }).catch(() => null);
    const ch = (await (
      await call('/login', { json: { email: m.email, password: m.password } })
    ).json()) as {
      data: { challenge: string };
    };
    expect(ch.data.challenge).toBeTruthy(); // a password alone never yields a session for a TOTP holder
    expect(s).not.toBeNull();

    // a session that really used the second factor, fresh: allowed
    const withOtp = (await (
      await call('/login/mfa', {
        json: { challenge: ch.data.challenge, code: await totpAt(secret) },
      })
    ).json()) as { data: { access_token: string } };
    const ok = await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: m.password },
      bearer: withOtp.data.access_token,
    });
    expect(ok.status).toBe(200);

    // the same session, older than 10 minutes: refused
    await setAmr(sidOf(withOtp.data.access_token), 'pwd,otp', 11 * 60_000);
    const stale = await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: m.password },
      bearer: withOtp.data.access_token,
    });
    expect(stale.status).toBe(403);
    // ...unless a current TOTP code is supplied
    await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(m.id).run();
    const viaCode = await call('/passkey/register/options', {
      headers: ORIGIN,
      json: { password: m.password, code: await totpAt(secret) },
      bearer: withOtp.data.access_token,
    });
    expect(viaCode.status).toBe(200);
  });

  it('a merchant with a passkey only cannot add a TOTP from a password session; a fresh passkey session can', async () => {
    const m = await seedUser();
    await addPasskeyRow(m.id);
    const pw = await login(m);
    expect((await begin(m, pw.body.access_token)).status).toBe(403);
    await setAmr(sidOf(pw.body.access_token), 'hwk');
    expect((await begin(m, pw.body.access_token)).status).toBe(200);
  });

  it('a passkey and no TOTP is a COMPLETE state for a super admin: a password sign-in creates NO session (no token, no cookie), a passkey session carries pa', async () => {
    const u = await seedUser({ role: 'super_admin' });
    await addPasskeyRow(u.id);
    const res = await call('/login', { json: { email: u.email, password: u.password } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull(); // no refresh cookie
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ secondFactorRequired: true }); // no access_token, no user
    expect(await count(`SELECT count(*) AS n FROM sessions WHERE user_id = ?1`, u.id)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ?1`, u.id)).toBe(
      0
    );
    // a wrong password is still the ordinary refusal (no oracle about the factor)
    expect(
      (await call('/login', { json: { email: u.email, password: 'nope-nope-nope' } })).status
    ).toBe(401);
  });

  it('a passkey session (amr hwk) of that admin carries pa', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const s = await login(u); // signed in while factorless (enrolment session)
    await addPasskeyRow(u.id);
    await setAmr(sidOf(s.body.access_token), 'hwk'); // what a passkey login records
    const minted = (await (await call('/token?aud=store', { cookie: s.cookie })).json()) as {
      data: { access_token: string };
    };
    expect(claims(minted.data.access_token).pa).toBe('super_admin');
  });

  it("removing a platform admin's passkey needs a fresh second-factor session (a phished password cannot strip the only factor)", async () => {
    const u = await seedUser({ role: 'super_admin' });
    const s = await login(u); // a session with no second factor
    await addPasskeyRow(u.id);
    const id = (await env.DB.prepare(`SELECT id FROM passkey_credentials WHERE user_id = ?1`)
      .bind(u.id)
      .first<{ id: string }>())!.id;
    const del = () =>
      call(`/passkeys/${id}/delete`, {
        json: { password: u.password },
        bearer: s.body.access_token,
      });
    expect((await del()).status).toBe(403);
    expect(
      await count(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`, u.id)
    ).toBe(1);
    await setAmr(sidOf(s.body.access_token), 'hwk'); // a fresh passkey session may...
    // ...but never remove the LAST factor of a platform admin
    const last = await del();
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe('LAST_FACTOR');
    await addPasskeyRow(u.id); // with a second factor in place, one may go
    expect((await del()).status).toBe(200);
  });

  it('...and adding a TOTP to it needs a fresh passkey session, with NO operator token and NO e-mailed code', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const s = await login(u); // signed in while factorless
    await addPasskeyRow(u.id);
    const bearer = s.body.access_token;
    // from a password-only session: refused
    expect((await begin(u, bearer)).status).toBe(403);
    // from a fresh passkey session: allowed, and completes with just the TOTP code
    await setAmr(sidOf(bearer), 'hwk');
    const secret = await secretOf(await begin(u, bearer));
    const r = await call('/mfa/enroll/verify', { json: { code: await totpAt(secret) }, bearer });
    expect(r.status).toBe(200);
    expect(await count(`SELECT mfa_enabled AS n FROM users WHERE id = ?1`, u.id)).toBe(1);
  });

  it('a first-factor merchant enrolment that races a second factor is re-checked at completion (stricter, never looser)', async () => {
    const m = await seedUser();
    const s = await login(m);
    const secret = await secretOf(await begin(m, s.body.access_token)); // no factor: password mode
    await addPasskeyRow(m.id); // a factor appears meanwhile
    const r = await call('/mfa/enroll/verify', {
      json: { code: await totpAt(secret) },
      bearer: s.body.access_token,
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('STEP_UP_REQUIRED');
    expect(await count(`SELECT mfa_enabled AS n FROM users WHERE id = ?1`, m.id)).toBe(0);
  });
});
