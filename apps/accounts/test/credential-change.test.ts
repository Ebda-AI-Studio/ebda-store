/** ID-06: MFA disable, passkey delete and phone change sign out every OTHER session and mail the owner. ID-08: retired keys expire. */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { call, emailCodeFor, fakes, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';
import { jwks } from '../src/keys';

beforeEach(() => {
  fakes.notices.length = 0;
  fakes.mails.length = 0;
  fakes.stores = [];
});

const meStatus = (bearer: string) => call('/me', { bearer }).then(r => r.status);

describe('ID-06: other sessions end and the owner is told', () => {
  it('a phone change keeps the acting session, ends the other one, and mails a credential_changed notice', async () => {
    const u = await seedUser();
    const acting = await login(u);
    const thief = await login(u);
    expect(await meStatus(thief.body.access_token)).toBe(200);
    const r = await call('/phone', {
      json: { phone: '+201001234567', password: u.password },
      bearer: acting.body.access_token,
    });
    expect(r.status).toBe(200);
    expect(await meStatus(acting.body.access_token)).toBe(200);
    expect(await meStatus(thief.body.access_token)).toBe(401);
    expect(fakes.notices).toEqual([
      expect.objectContaining({ to: u.email, kind: 'credential_changed', change: 'phone_changed' }),
    ]);
  });

  it('turning MFA off does the same', async () => {
    const u = await seedUser();
    const acting = await login(u);
    const secret = (
      (await (
        await call('/mfa/enroll', {
          json: { password: u.password },
          bearer: acting.body.access_token,
        })
      ).json()) as { data: { secret: string } }
    ).data.secret;
    const done = await call('/mfa/enroll/verify', {
      json: {
        code: await totpAt(secret),
        emailCode: await emailCodeFor(u, acting.body.access_token),
      },
      bearer: acting.body.access_token,
    });
    expect(done.status).toBe(200);
    await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
      .bind(u.id)
      .run();
    // a second session opened after enrolment (password login now needs the second step, so mint it straight in D1's sessions)
    const other = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO sessions (sid, user_id, created_at, expires_at, ip, user_agent, amr) VALUES (?1,?2,?3,?4,'1.1.1.1','t','pwd')`
    )
      .bind(other, u.id, Date.now(), Date.now() + 3_600_000)
      .run();
    fakes.notices.length = 0;
    const r = await call('/mfa/disable', {
      json: { password: u.password, code: await totpAt(secret) },
      bearer: acting.body.access_token,
    });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE sid = ?1`)
      .bind(other)
      .first<{ revoked_at: number | null }>();
    expect(row!.revoked_at).not.toBeNull();
    expect(fakes.notices).toEqual([
      expect.objectContaining({ to: u.email, kind: 'credential_changed', change: 'mfa_disabled' }),
    ]);
  });
});

describe('ID-08: a retired signing key is published only until its own exp', () => {
  const retired = (kid: string, exp?: number) => ({
    kty: 'EC',
    crv: 'P-256',
    x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    kid,
    alg: 'ES256',
    use: 'sig',
    ...(exp === undefined ? {} : { exp }),
  });
  const nowS = () => Math.floor(Date.now() / 1000);
  const set = async (prev: unknown[]) => {
    const e = { ...env, JWT_PREVIOUS_PUBLIC_JWKS: JSON.stringify(prev) };
    return (await jwks(e as never)).keys.map(k => k.kid);
  };

  it('publishes an unexpired retired key (without the bookkeeping exp member)', async () => {
    const keys = (
      await jwks({
        ...env,
        JWT_PREVIOUS_PUBLIC_JWKS: JSON.stringify([retired('old-1', nowS() + 3600)]),
      } as never)
    ).keys;
    expect(keys.map(k => k.kid)).toContain('old-1');
    expect(keys.every(k => !('exp' in k))).toBe(true);
  });
  it('drops an expired retired key', async () => {
    expect(await set([retired('old-2', nowS() - 1)])).not.toContain('old-2');
  });
  it('does not publish a retired key that has no exp (fail closed)', async () => {
    expect(await set([retired('old-3')])).not.toContain('old-3');
  });
});
