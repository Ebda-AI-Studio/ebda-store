import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { call, fakes, login, seedUser, testEnv } from './helpers';
import { Accounts } from '../src/index';

const rpc = () => new Accounts({} as never, testEnv());
beforeEach(() => {
  fakes.mails.length = 0;
});

describe('Accounts RPC for the Store', () => {
  it('getAccountState returns identity facts and never a credential', async () => {
    const u = await seedUser({ role: 'super_admin' });
    const st = await rpc().getAccountState(u.id);
    expect(st).toMatchObject({
      id: u.id,
      email: u.email,
      emailVerified: true,
      mfaEnabled: false,
      status: 'active',
      role: 'super_admin',
    });
    expect(Object.keys(st!)).not.toContain('password_hash');
    expect(JSON.stringify(st)).not.toMatch(/\$2[aby]\$/);
    expect(await rpc().getAccountState(crypto.randomUUID())).toBeNull();
  });

  it('setStatus away from active ends every session and blocks sign-in; reactivation restores sign-in', async () => {
    const u = await seedUser();
    const s = await login(u);
    await rpc().setStatus(u.id, 'suspended', 'test');
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
    expect((await call('/login', { json: { email: u.email, password: u.password } })).status).toBe(
      401
    );
    await rpc().setStatus(u.id, 'active', 'test');
    expect((await call('/login', { json: { email: u.email, password: u.password } })).status).toBe(
      200
    );
    await expect(rpc().setStatus('not-a-uuid', 'active', 'x')).rejects.toThrow();
    await expect(rpc().setStatus(u.id, 'bogus' as never, 'x')).rejects.toThrow();
  });

  it('updateProfile edits name / phone, clears a phone, keeps sessions, and never touches credentials', async () => {
    const u = await seedUser();
    const s = await login(u);
    expect(
      await rpc().updateProfile(u.id, {
        firstName: ' Nour ',
        lastName: 'Ali',
        phone: '+201001112223',
      })
    ).toEqual({ ok: true });
    expect(
      await env.DB.prepare(`SELECT first_name, last_name, phone FROM users WHERE id = ?1`)
        .bind(u.id)
        .first()
    ).toMatchObject({ first_name: 'Nour', last_name: 'Ali', phone: '+201001112223' });
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(200);
    await rpc().updateProfile(u.id, { phone: null });
    expect(
      await env.DB.prepare(`SELECT phone FROM users WHERE id = ?1`).bind(u.id).first()
    ).toMatchObject({ phone: null });
    expect((await call('/login', { json: { email: u.email, password: u.password } })).status).toBe(
      200
    );
    await expect(rpc().updateProfile(u.id, { role: 'super_admin' } as never)).rejects.toThrow();
    await expect(rpc().updateProfile('not-a-uuid', { firstName: 'x' })).rejects.toThrow();
  });

  it('updateProfile never changes the e-mail (strict schema), and a super_admin target only by that same user', async () => {
    const u = await seedUser();
    await expect(
      rpc().updateProfile(u.id, { email: 'new@example.com' } as never)
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(`SELECT email FROM users WHERE id = ?1`).bind(u.id).first()
    ).toMatchObject({ email: u.email });
    const admin = await seedUser({ role: 'super_admin' });
    const other = await seedUser();
    expect(await rpc().updateProfile(admin.id, { firstName: 'Hacked' }, 'x', other.id)).toEqual({
      ok: false,
      code: 'FORBIDDEN_TARGET',
    });
    expect(await rpc().updateProfile(admin.id, { firstName: 'Hacked' })).toEqual({
      ok: false,
      code: 'FORBIDDEN_TARGET',
    });
    expect(
      await env.DB.prepare(`SELECT first_name FROM users WHERE id = ?1`).bind(admin.id).first()
    ).not.toMatchObject({ first_name: 'Hacked' });
    expect(await rpc().updateProfile(admin.id, { firstName: 'Self' }, 'x', admin.id)).toEqual({
      ok: true,
    });
  });

  it('updateProfile refuses an unknown, erased or customer account', async () => {
    const c = await seedUser({ role: 'customer' });
    expect(await rpc().updateProfile(c.id, { firstName: 'x' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await rpc().updateProfile(crypto.randomUUID(), { firstName: 'x' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('eraseUser removes the identity and every session with it; a stale token and cookie are dead; idempotent', async () => {
    const u = await seedUser();
    const s = await login(u);
    await rpc().eraseUser(u.id);
    await rpc().eraseUser(u.id);
    expect(await rpc().getAccountState(u.id)).toBeNull();
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
    expect((await call('/me', { bearer: s.body.access_token })).status).toBe(401);
    expect((await call('/login', { json: { email: u.email, password: u.password } })).status).toBe(
      401
    );
    const sid = (await import('jose')).decodeJwt(s.body.access_token).sid as string;
    expect(await rpc().isRevoked(sid)).toBe(true);
    expect(
      await env.DB.prepare(`SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ?1`)
        .bind(u.id)
        .first()
    ).toMatchObject({ n: 0 });
  });

  it('setRole changes the grant and ends sessions; super_admin is not grantable over RPC', async () => {
    const u = await seedUser();
    const s = await login(u);
    await expect(rpc().setRole(u.id, 'super_admin' as never, 'test')).rejects.toThrow();
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(200);
    await rpc().setRole(u.id, 'staff', 'test');
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
    expect(
      await env.DB.prepare(`SELECT role FROM users WHERE id = ?1`).bind(u.id).first()
    ).toMatchObject({ role: 'staff' });
  });

  it('setRole with ifCurrentRole is a compare-and-set: no match = no change and no sessions ended', async () => {
    const u = await seedUser();
    await env.DB.prepare(`UPDATE users SET role = 'store_admin' WHERE id = ?1`).bind(u.id).run();
    const s = await login(u);
    // the role is store_admin, so a rollback that expects 'staff' must do nothing
    expect(await rpc().setRole(u.id, 'store_admin', 'rollback', 'staff')).toBe(false);
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(200);
    // once it really is staff, the same call restores the role and ends the sessions
    await env.DB.prepare(`UPDATE users SET role = 'staff' WHERE id = ?1`).bind(u.id).run();
    expect(await rpc().setRole(u.id, 'store_admin', 'rollback', 'staff')).toBe(true);
    expect(
      await env.DB.prepare(`SELECT role FROM users WHERE id = ?1`).bind(u.id).first()
    ).toMatchObject({
      role: 'store_admin',
    });
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
  });

  it('inviteUser creates an unverified, credential-less account and mails a 24h staff_invite code', async () => {
    const id = crypto.randomUUID();
    const email = `invitee-${id.slice(0, 8)}@example.com`;
    const r = await rpc().inviteUser({
      id,
      email,
      firstName: 'Sam',
      lastName: 'Lee',
      role: 'staff',
      storeName: 'Demo',
    });
    expect(r).toEqual({ id, created: true });
    expect(
      await env.DB.prepare(`SELECT password_hash, email_verified FROM users WHERE id = ?1`)
        .bind(id)
        .first()
    ).toMatchObject({ password_hash: '!pending', email_verified: 0 });
    expect(fakes.mails.at(-1)).toMatchObject({
      to: email,
      kind: 'staff_invite',
      ttlMinutes: 1440,
      storeName: 'Demo',
    });
    // the invitee cannot sign in with any password until they set one
    expect(
      (await call('/login', { method: 'POST', json: { email, password: '!pending' } })).status
    ).toBeGreaterThanOrEqual(400);
    // a VERIFIED account is reported, never touched, and nothing is mailed
    const v = await seedUser();
    const mails = fakes.mails.length;
    expect(
      await rpc().inviteUser({
        id: crypto.randomUUID(),
        email: v.email,
        firstName: 'X',
        lastName: 'Y',
        role: 'staff',
      })
    ).toMatchObject({ id: v.id, created: false, emailVerified: true });
    expect(fakes.mails.length).toBe(mails);
  });

  it('inviteUser never binds to an existing unverified row (cross-tenant takeover): it reports the REAL id, role and flag', async () => {
    const victim = await seedUser({ emailVerified: 0 });
    await env.DB.prepare(`UPDATE users SET role = 'store_admin' WHERE id = ?1`)
      .bind(victim.id)
      .run();
    const before = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`)
      .bind(victim.id)
      .first();
    const mails = fakes.mails.length;
    const r = await rpc().inviteUser({
      id: crypto.randomUUID(),
      email: victim.email,
      firstName: 'Mallory',
      lastName: 'M',
      role: 'staff',
      storeName: 'Evil Store',
    });
    expect(r).toEqual({ id: victim.id, created: false, emailVerified: false, role: 'store_admin' });
    expect(fakes.mails.length).toBe(mails); // no code mailed on the attacker's behalf
    expect(
      await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(victim.id).first()
    ).toEqual(before);
  });

  it('inviteUser retried with the same id and role re-mails the code (idempotent retry)', async () => {
    const id = crypto.randomUUID();
    const email = `retry-${id.slice(0, 8)}@example.com`;
    const input = {
      id,
      email,
      firstName: 'Sam',
      lastName: 'Lee',
      role: 'staff' as const,
      storeName: 'Demo',
    };
    await rpc().inviteUser(input);
    const n = fakes.mails.length;
    expect(await rpc().inviteUser(input)).toEqual({ id, created: true });
    expect(fakes.mails.length).toBe(n + 1);
  });

  async function withEveryKindOfData() {
    const u = await seedUser();
    const s = await login(u); // a session + a refresh token
    await env.DB.prepare(
      `UPDATE users SET mfa_enabled = 1, mfa_secret = 'sealed-secret', mfa_backup_codes = '["x"]', phone = '+201001234567' WHERE id = ?1`
    )
      .bind(u.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, device_type, rp_id, name, created_at)
       VALUES (?1,?2,?3,'pk','singleDevice','store.ebda.app','My key',?4)`
    )
      .bind(crypto.randomUUID(), u.id, `cred-${u.id}`, new Date().toISOString())
      .run();
    await rpc().forgotPassword(u.email); // a verification token
    await env.DB.prepare(
      `INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?1,'mfa',?2,'{}',?3)`
    )
      .bind(crypto.randomUUID(), u.id, Date.now() + 60_000)
      .run();
    await env.DB.prepare(`INSERT INTO login_attempts (key, at) VALUES (?1, ?2)`)
      .bind(`e:${u.email.toLowerCase()}`, Date.now())
      .run();
    const sid = (await import('jose')).decodeJwt(s.body.access_token).sid as string;
    return { u, s, sid };
  }
  const rowsFor = async (id: string, email: string) => {
    const n = async (sql: string, ...b: unknown[]) =>
      ((
        await env.DB.prepare(sql)
          .bind(...b)
          .first<{ n: number }>()
      )?.n ?? 0) as number;
    return {
      users: await n(`SELECT count(*) AS n FROM users WHERE id = ?1`, id),
      sessions: await n(`SELECT count(*) AS n FROM sessions WHERE user_id = ?1`, id),
      refresh: await n(`SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ?1`, id),
      verification: await n(`SELECT count(*) AS n FROM verification_tokens WHERE user_id = ?1`, id),
      passkeys: await n(`SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?1`, id),
      challenges: await n(`SELECT count(*) AS n FROM challenges WHERE user_id = ?1`, id),
      attempts: await n(
        `SELECT count(*) AS n FROM login_attempts WHERE key = ?1`,
        `e:${email.toLowerCase()}`
      ),
    };
  };

  it('eraseUser (G10) deletes the user, sessions, refresh + verification tokens, passkeys, MFA, challenges and throttle rows, and revokes every sid', async () => {
    const { u, s, sid } = await withEveryKindOfData();
    const other = await seedUser();
    await login(other);
    const before = await rowsFor(u.id, u.email);
    expect(Object.values(before).every(n => n >= 1)).toBe(true); // the fixture really has every kind
    expect(await rpc().eraseUser(u.id, 'req-1')).toEqual({ erased: true, remaining: 0 });
    expect(Object.values(await rowsFor(u.id, u.email)).every(n => n === 0)).toBe(true);
    expect(await rpc().isRevoked(sid)).toBe(true);
    expect((await call('/token?aud=store', { cookie: s.cookie })).status).toBe(401);
    expect(
      await env.DB.prepare(`SELECT 1 FROM users WHERE id = ?1`).bind(other.id).first()
    ).toBeTruthy();
    expect((await rowsFor(other.id, other.email)).sessions).toBeGreaterThan(0); // untouched
  });

  it('eraseUser is idempotent per request id, and the address can be registered again afterwards', async () => {
    const { u } = await withEveryKindOfData();
    await rpc().eraseUser(u.id, 'req-2');
    expect(await rpc().eraseUser(u.id, 'req-2')).toEqual({ erased: false, remaining: 0 });
    const again = await seedUser({ email: u.email });
    expect(again.email).toBe(u.email);
  });

  it('exportUser (G10) returns the identity data as JSON and never a secret or credential material', async () => {
    const { u } = await withEveryKindOfData();
    const out = await rpc().exportUser(u.id);
    expect(Object.keys(out).sort()).toEqual([
      'admin_audit',
      'passkey_credentials',
      'refresh_tokens',
      'sessions',
      'users',
      'verification_tokens',
    ]);
    expect(out.users).toHaveLength(1);
    expect(out.users[0]).toMatchObject({
      id: u.id,
      email: u.email,
      phone: '+201001234567',
      mfa_enabled: 1,
    });
    expect(out.sessions.length).toBeGreaterThan(0);
    expect(out.passkey_credentials).toHaveLength(1);
    const text = JSON.stringify(out);
    for (const secret of [
      'password_hash',
      'mfa_secret',
      'sealed-secret',
      'mfa_backup_codes',
      'public_key',
      '"token"',
      'pending',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('exportUser for an unknown user is every table empty, and erase then export returns nothing', async () => {
    const empty = await rpc().exportUser(crypto.randomUUID());
    expect(Object.values(empty).every(a => a.length === 0)).toBe(true);
    const { u } = await withEveryKindOfData();
    await rpc().eraseUser(u.id);
    expect(Object.values(await rpc().exportUser(u.id)).every(a => a.length === 0)).toBe(true);
  });

  it('accountIdByEmail returns the live account id (case-insensitive) and null for an unknown address', async () => {
    const u = await seedUser();
    expect(await rpc().accountIdByEmail(u.email.toUpperCase())).toBe(u.id);
    expect(await rpc().accountIdByEmail('nobody@example.com')).toBeNull();
    await expect(rpc().accountIdByEmail('not an email')).rejects.toThrow();
  });

  it('forgotPassword mails a reset code for an active account and is silent for an unknown address', async () => {
    const u = await seedUser();
    const before = fakes.mails.length;
    await rpc().forgotPassword('nobody@example.com');
    expect(fakes.mails.length).toBe(before);
    await rpc().forgotPassword(u.email);
    expect(fakes.mails.at(-1)).toMatchObject({ to: u.email, kind: 'password_reset' });
  });

  it('resendVerification mails a code only for an existing unverified account', async () => {
    const unverified = await seedUser({ emailVerified: 0 });
    const verified = await seedUser();
    await rpc().resendVerification(verified.email);
    await rpc().resendVerification('nobody@example.com');
    expect(fakes.mails).toHaveLength(0);
    await rpc().resendVerification(unverified.email);
    expect(fakes.mails).toHaveLength(1);
    void env;
  });
});

describe('getAccountsBrief (NEON-ZERO-1: one identity read for a member list)', () => {
  it('returns display facts for known ids only, never a credential or phone, and caps the batch at 100', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const out = await rpc().getAccountsBrief([a.id, b.id, crypto.randomUUID()]);
    expect(out.map(u => u.id).sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(out)).not.toMatch(/password|phone|token|secret/i);
    expect(await rpc().getAccountsBrief([])).toEqual([]);
    await expect(
      rpc().getAccountsBrief(Array.from({ length: 101 }, () => crypto.randomUUID()))
    ).rejects.toBeTruthy();
  });
});
