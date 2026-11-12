/** Password-less platform-admin bootstrap (Ruling ID-20): CLI helpers, the D1 writes, the mail-driven password, the gates. */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { call, fakes, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';
import { sha256Hex } from '../src/util';
import { eraseIdentity, exportIdentity, superAdminSummary } from '../src/data';
import {
  NO_PASSWORD,
  actorName,
  buildBootstrapSql,
  buildIssueTokenSql,
  parseBootstrapArgs,
  planBootstrap,
  readState,
  resetIssuedSql,
  stateSql,
} from '../scripts/bootstrap-super-admin-sql.mjs';

const ORIGIN = { origin: 'https://store.ebda.app' };
const run = (statements: string[]) => env.DB.batch(statements.map(s => env.DB.prepare(s)));
const state = async (email: string) =>
  readState(await env.DB.prepare(stateSql(email)).first<Record<string, unknown>>());
const flags = { allowAdditional: false, resendEmail: false, issueEnrolmentToken: false };
const fresh = () => `boot-${crypto.randomUUID().slice(0, 8)}@example.com`;
const create = (email: string, userId = crypto.randomUUID(), allowAdditional = false) =>
  run(
    buildBootstrapSql({
      userId,
      email,
      firstName: 'Ahmad',
      lastName: 'Sharaf',
      actor: 'op@example.com',
      nowMs: Date.now(),
      allowAdditional,
    })
  ).then(() => userId);
const audits = (email: string) =>
  env.DB.prepare(
    `SELECT event, user_id, actor, detail FROM admin_audit WHERE email = ?1 ORDER BY id`
  )
    .bind(email)
    .all<{ event: string; user_id: string; actor: string; detail: string }>()
    .then(r => r.results);

// The suite shares one D1: platform admins seeded by other files would make "no other admin" untrue, so start clean.
beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM users WHERE role = 'super_admin'`).run();
});

describe('bootstrap-super-admin CLI helpers', () => {
  it('dry run is the default; no password, hash, code or token is ever accepted as an argument', () => {
    expect(parseBootstrapArgs(['--email=Boss@Example.com', '--remote']).apply).toBe(false);
    expect(parseBootstrapArgs(['--email=Boss@Example.com', '--remote']).email).toBe(
      'boss@example.com'
    );
    for (const a of [
      '--password=x',
      '--pass=x',
      '--pwd',
      '--hash=$2a$',
      '--code=123456',
      '--token=abc',
    ]) {
      expect(() => parseBootstrapArgs(['--email=b@example.com', '--remote', a])).toThrow(
        /is ever passed as an argument/
      );
    }
    expect(
      parseBootstrapArgs(['--email=b@example.com', '--remote', '--issue-enrolment-token'])
        .issueEnrolmentToken
    ).toBe(true);
  });

  it('needs exactly one of --remote / --local and a clean address', () => {
    expect(() => parseBootstrapArgs(['--email=b@example.com'])).toThrow(/--remote/);
    expect(() => parseBootstrapArgs(['--email=b@example.com', '--remote', '--local'])).toThrow(
      /--remote/
    );
    expect(() => parseBootstrapArgs(["--email=a'b@example.com", '--remote'])).toThrow();
    expect(() => parseBootstrapArgs(['--remote'])).toThrow();
  });

  it('refuses anything that is not a clean value before it can reach SQL', () => {
    const base = {
      userId: crypto.randomUUID(),
      email: 'b@example.com',
      firstName: 'A',
      lastName: 'B',
      actor: 'op@example.com',
      nowMs: Date.now(),
    };
    expect(() => buildBootstrapSql({ ...base, email: "a'b@example.com" })).toThrow();
    expect(() => buildBootstrapSql({ ...base, userId: "1' OR '1'='1" })).toThrow();
    expect(() => buildBootstrapSql({ ...base, actor: "x'); DROP TABLE users;--" })).toThrow();
    expect(() =>
      buildIssueTokenSql({ ...base, tokenId: crypto.randomUUID(), tokenHash: 'nothex' })
    ).toThrow();
    expect(() => stateSql("x' OR 1=1 --@a.co")).toThrow();
    expect(() => resetIssuedSql(base.userId, "2026'")).toThrow();
    expect(actorName("ev'il; name")).toBe('evilname');
    expect(actorName('')).toBe('unknown');
  });

  it('plan: every branch', () => {
    const sa = {
      id: 'x',
      role: 'super_admin',
      status: 'active',
      emailVerified: false,
      noPassword: true,
      hasFactor: false,
    };
    expect(planBootstrap({ otherAdmins: 0, target: null }, flags).action).toBe('create');
    expect(planBootstrap({ otherAdmins: 1, target: null }, flags)).toMatchObject({
      action: 'refuse',
    });
    expect(
      planBootstrap({ otherAdmins: 1, target: null }, { ...flags, allowAdditional: true }).action
    ).toBe('create');
    expect(
      planBootstrap({ otherAdmins: 0, target: { ...sa, role: 'store_admin' } }, flags).reason
    ).toMatch(/upsert-super-admin/);
    expect(planBootstrap({ otherAdmins: 0, target: sa }, flags).action).toBe('noop');
    expect(
      planBootstrap({ otherAdmins: 0, target: sa }, { ...flags, resendEmail: true }).action
    ).toBe('resend');
    expect(
      planBootstrap({ otherAdmins: 0, target: { ...sa, status: 'suspended' } }, flags).action
    ).toBe('refuse');
    // the token only after the password is set, and never when a factor exists
    const tok = { ...flags, issueEnrolmentToken: true };
    expect(planBootstrap({ otherAdmins: 0, target: sa }, tok).reason).toMatch(
      /password is not set/
    );
    expect(
      planBootstrap(
        { otherAdmins: 0, target: { ...sa, emailVerified: true, noPassword: false } },
        tok
      ).action
    ).toBe('issue-token');
    expect(
      planBootstrap(
        {
          otherAdmins: 0,
          target: { ...sa, emailVerified: true, noPassword: false, hasFactor: true },
        },
        tok
      ).action
    ).toBe('refuse');
    expect(planBootstrap({ otherAdmins: 0, target: null }, tok).action).toBe('refuse');
  });
});

describe('bootstrap against the real identity D1', () => {
  it('CREATE: an active super_admin with NO password and an UNVERIFIED address, plus one audit row; nobody can sign in', async () => {
    const email = fresh();
    const id = await create(email);
    const row = await env.DB.prepare(
      `SELECT role, status, email_verified, password_hash = ?2 AS no_pw, mfa_enabled FROM users WHERE id = ?1`
    )
      .bind(id, NO_PASSWORD)
      .first();
    expect(row).toMatchObject({
      role: 'super_admin',
      status: 'active',
      email_verified: 0,
      no_pw: 1,
      mfa_enabled: 0,
    });
    expect(await audits(email)).toEqual([
      {
        event: 'super_admin_bootstrapped',
        user_id: id,
        actor: 'op@example.com',
        detail: '{"allowAdditional":false}',
      },
    ]);
    // the marker is not a credential: any password fails the same way a wrong one does
    expect((await login({ email, password: NO_PASSWORD })).res.status).toBe(401);
    expect((await login({ email, password: 'Anything-At-All-1!' })).res.status).toBe(401);
  });

  it('idempotent: a second create for the same address inserts no user and no audit row; the plan becomes noop', async () => {
    const email = fresh();
    const id = await create(email);
    await create(email); // a racing run with a different new id
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM users WHERE lower(email) = ?1`)
      .bind(email)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect((await audits(email)).map(a => a.user_id)).toEqual([id]);
    expect(planBootstrap(await state(email), flags).action).toBe('noop');
  });

  it('refuses a second platform admin unless --allow-additional, and records the flag when it is used', async () => {
    await create(fresh());
    const second = fresh();
    const s = await state(second);
    expect(s.otherAdmins).toBe(1);
    expect(planBootstrap(s, flags).action).toBe('refuse');
    expect(planBootstrap(s, { ...flags, allowAdditional: true }).action).toBe('create');
    await create(second, crypto.randomUUID(), true);
    expect((await audits(second))[0].detail).toBe('{"allowAdditional":true}');
  });

  it('an address owned by a merchant is refused (promotion is the upsert script, which clears factors)', async () => {
    const m = await seedUser({ role: 'store_admin' });
    expect(planBootstrap(await state(m.email), flags)).toMatchObject({ action: 'refuse' });
  });

  it('full path: mailed code sets the password -> no admin power -> operator token + mailed code enrol TOTP -> pa', async () => {
    const email = fresh();
    const id = await create(email);
    expect(await superAdminSummary(env.DB)).toEqual({ active: 1, ready: 0 });

    // the script's mail step: the service's own forgot-password path mails the code
    const since = new Date(Date.now() - 5_000).toISOString();
    fakes.mails.length = 0;
    expect((await call('/password/forgot', { json: { email } })).status).toBe(202);
    const mail = fakes.mails.find(m => m.to === email && m.kind === 'password_reset');
    expect(mail).toBeTruthy();
    expect((await env.DB.prepare(resetIssuedSql(id, since)).first<{ n: number }>())!.n).toBe(1);

    // the owner sets the password with that code; it also verifies the address
    const password = 'Owner-Chosen-Passw0rd!';
    expect(
      (await call('/password/reset', { json: { email, code: mail!.code, newPassword: password } }))
        .status
    ).toBe(200);
    const s1 = await login({ email, password });
    expect(s1.res.status).toBe(200);
    expect(claims(s1.body.access_token).pa).toBeUndefined();
    expect((s1.body as unknown as { mfaEnrollmentRequired?: boolean }).mfaEnrollmentRequired).toBe(
      true
    );
    expect(await superAdminSummary(env.DB)).toEqual({ active: 1, ready: 0 });

    // without the operator token the first factor cannot be bound
    const bearer = s1.body.access_token;
    const begin = await call('/mfa/enroll', { json: { password }, bearer });
    const secret = ((await begin.json()) as { data: { secret: string } }).data.secret;
    await call('/mfa/bootstrap/code', { json: { password }, bearer });
    const emailCode = fakes.mails.at(-1)!.code;
    expect(
      (
        await call('/mfa/enroll/verify', {
          json: { code: await totpAt(secret), emailCode },
          bearer,
        })
      ).status
    ).toBe(403);

    // the owner's --issue-enrolment-token step (same SQL the CLI runs), then both proofs enrol
    const st = await state(email);
    expect(planBootstrap(st, { ...flags, issueEnrolmentToken: true }).action).toBe('issue-token');
    const token = crypto.randomUUID() + crypto.randomUUID();
    await run(
      buildIssueTokenSql({
        userId: id,
        email,
        actor: 'owner',
        nowMs: Date.now(),
        tokenId: crypto.randomUUID(),
        tokenHash: await sha256Hex(token),
      })
    );
    await call('/mfa/bootstrap/code', { json: { password }, bearer });
    await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(id).run();
    const ok = await call('/mfa/enroll/verify', {
      json: {
        code: await totpAt(secret),
        emailCode: fakes.mails.at(-1)!.code,
        enrolmentToken: token,
      },
      bearer,
    });
    expect(ok.status).toBe(200);
    expect((await audits(email)).map(a => a.event)).toEqual([
      'super_admin_bootstrapped',
      'super_admin_enrolment_token_issued',
    ]);
    expect(await superAdminSummary(env.DB)).toEqual({ active: 1, ready: 1 });

    // the password alone no longer signs in; password + TOTP mints pa
    const pw = await call('/login', { json: { email, password, aud: 'store' }, headers: ORIGIN });
    const challenge = ((await pw.json()) as { data: { mfaRequired: boolean; challenge: string } })
      .data;
    expect(challenge.mfaRequired).toBe(true);
    await env.DB.prepare(`UPDATE users SET mfa_last_step = NULL WHERE id = ?1`).bind(id).run();
    const mfa = await call('/login/mfa', {
      json: { challenge: challenge.challenge, code: await totpAt(secret) },
      headers: ORIGIN,
    });
    expect(mfa.status).toBe(200);
    const t = ((await mfa.json()) as { data: { access_token: string } }).data.access_token;
    expect(claims(t).pa).toBe('super_admin');
  });

  it('PDPL: export carries the audit rows; erasure keeps the event but not the address', async () => {
    const email = fresh();
    const id = await create(email);
    expect((await exportIdentity(env.DB, id)).admin_audit).toHaveLength(1);
    expect(await eraseIdentity(env.DB, id)).toEqual({ erased: true, remaining: 0 });
    expect(await audits(email)).toEqual([]);
    const left = await env.DB.prepare(`SELECT email FROM admin_audit WHERE user_id = ?1`)
      .bind(id)
      .all();
    expect(left.results).toEqual([{ email: 'erased' }]);
  });

  it('superAdminSummary: suspended and erased admins are not counted', async () => {
    expect(await superAdminSummary(env.DB)).toEqual({ active: 0, ready: 0 });
    const a = await create(fresh());
    const b = await create(fresh(), crypto.randomUUID(), true);
    expect((await superAdminSummary(env.DB)).active).toBe(2);
    await env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?1`).bind(a).run();
    await env.DB.prepare(`UPDATE users SET deleted_at = ?2 WHERE id = ?1`)
      .bind(b, new Date().toISOString())
      .run();
    expect(await superAdminSummary(env.DB)).toEqual({ active: 0, ready: 0 });
  });
});

const claims = (t: string) => decodeJwt(t) as Record<string, unknown>;
