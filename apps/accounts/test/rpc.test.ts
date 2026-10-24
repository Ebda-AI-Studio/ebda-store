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
    expect(r).toEqual({ id });
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
    // a VERIFIED account is never touched
    const v = await seedUser();
    expect(
      await rpc().inviteUser({
        id: crypto.randomUUID(),
        email: v.email,
        firstName: 'X',
        lastName: 'Y',
        role: 'staff',
      })
    ).toBeNull();
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
