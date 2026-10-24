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
