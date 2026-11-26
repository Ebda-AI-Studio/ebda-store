/**
 * SELF-SERVICE gap A23: a signed-in owner regenerates their MFA recovery codes without staff. The old set dies, the new
 * set works once, codes are hashed at rest, and the step-up (password + a LIVE authenticator code) is mandatory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { call, emailCodeFor, fakes, login, seedUser } from './helpers';
import { totpAt } from '../src/totp';

beforeEach(() => {
  fakes.mails.length = 0;
  fakes.stores = [];
});

async function withMfa(u: { email: string; password: string; id: string }) {
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
  // let the next TOTP claim reuse the current time step
  await env.DB.prepare(`UPDATE users SET mfa_last_step = mfa_last_step - 5 WHERE id = ?1`)
    .bind(s.body.user.id)
    .run();
  return { secret, backupCodes: done.data.backupCodes, s };
}

async function loginWithBackup(u: { email: string; password: string }, backupCode: string) {
  const first = (await (
    await call('/login', { json: { email: u.email, password: u.password } })
  ).json()) as {
    data: { challenge: string };
  };
  return call('/login/mfa', { json: { challenge: first.data.challenge, backupCode } });
}

describe('A23 recovery codes: enrolment issues 10, hashed at rest, single use', () => {
  it('10 codes, none stored in plain text, one works exactly once', async () => {
    const u = await seedUser();
    const { backupCodes } = await withMfa(u);
    expect(backupCodes).toHaveLength(10);
    const row = await env.DB.prepare(`SELECT mfa_backup_codes FROM users WHERE id = ?1`)
      .bind(u.id)
      .first<{ mfa_backup_codes: string }>();
    const stored = JSON.parse(row!.mfa_backup_codes) as string[];
    expect(stored).toHaveLength(10);
    for (const c of backupCodes) expect(row!.mfa_backup_codes).not.toContain(c);
    expect(stored.every(h => h.startsWith('$2'))).toBe(true);
    expect((await loginWithBackup(u, backupCodes[0])).status).toBe(200);
    expect((await loginWithBackup(u, backupCodes[0])).status).toBe(401);
  });
});

describe('A23 regenerate with step-up', () => {
  it('a new set replaces the old one: old codes fail, new codes work once, still 10 and hashed', async () => {
    const u = await seedUser();
    const { secret, backupCodes: oldSet, s } = await withMfa(u);
    const res = await call('/mfa/recovery-codes/regenerate', {
      json: { password: u.password, code: await totpAt(secret) },
      bearer: s.body.access_token,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { backupCodes: string[] } };
    expect(data.backupCodes).toHaveLength(10);
    expect(new Set(data.backupCodes).size).toBe(10);
    const row = await env.DB.prepare(`SELECT mfa_backup_codes FROM users WHERE id = ?1`)
      .bind(u.id)
      .first<{ mfa_backup_codes: string }>();
    for (const c of [...data.backupCodes, ...oldSet])
      expect(row!.mfa_backup_codes).not.toContain(c);
    expect((await loginWithBackup(u, oldSet[0])).status).toBe(401);
    expect((await loginWithBackup(u, data.backupCodes[0])).status).toBe(200);
    expect((await loginWithBackup(u, data.backupCodes[0])).status).toBe(401);
  });

  it('refuses without the password, with a wrong authenticator code, and without a bearer token; the old set survives', async () => {
    const u = await seedUser();
    const { secret, backupCodes, s } = await withMfa(u);
    const bearer = s.body.access_token;
    expect(
      (
        await call('/mfa/recovery-codes/regenerate', {
          json: { password: 'wrong-password-1', code: await totpAt(secret) },
          bearer,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call('/mfa/recovery-codes/regenerate', {
          json: { password: u.password, code: '000000' },
          bearer,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call('/mfa/recovery-codes/regenerate', {
          json: { password: u.password, code: await totpAt(secret) },
        })
      ).status
    ).toBe(401);
    // a recovery code is NOT an accepted step-up here: it must not be able to mint more of itself
    expect(
      (
        await call('/mfa/recovery-codes/regenerate', {
          json: { password: u.password, code: backupCodes[1] },
          bearer,
        })
      ).status
    ).toBe(400);
    expect((await loginWithBackup(u, backupCodes[2])).status).toBe(200);
  });

  it('an account without MFA cannot regenerate (nothing to regenerate)', async () => {
    const u = await seedUser();
    const s = await login(u);
    const res = await call('/mfa/recovery-codes/regenerate', {
      json: { password: u.password, code: '123456' },
      bearer: s.body.access_token,
    });
    expect(res.status).toBe(409);
  });

  it('reports only how many codes are left, never the codes', async () => {
    const u = await seedUser();
    const { backupCodes, s } = await withMfa(u);
    await loginWithBackup(u, backupCodes[0]);
    const res = await call('/mfa/recovery-codes', { bearer: s.body.access_token, method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { remaining: number } };
    expect(body.data).toEqual({ remaining: 9 });
  });
});

describe('A23 regenerate emits a structured audit event', () => {
  it('logs mfa_recovery_codes_regenerated with the user id and never a code; a refused step-up logs nothing', async () => {
    const u = await seedUser();
    const { secret, s } = await withMfa(u);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await call('/mfa/recovery-codes/regenerate', {
        json: { password: u.password, code: '000000' },
        bearer: s.body.access_token,
      });
      expect(spy).not.toHaveBeenCalled();
      const res = await call('/mfa/recovery-codes/regenerate', {
        json: { password: u.password, code: await totpAt(secret) },
        bearer: s.body.access_token,
      });
      const { data } = (await res.json()) as { data: { backupCodes: string[] } };
      const lines = spy.mock.calls.map(c => String(c[0]));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        event: 'mfa_recovery_codes_regenerated',
        userId: u.id,
      });
      for (const c of data.backupCodes) expect(lines[0]).not.toContain(c);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('A23 regenerate leaves an audit row and tells the mailbox owner', () => {
  it('writes one admin_audit row (no code, no hash) and mails a "recovery codes changed" notice', async () => {
    const u = await seedUser();
    const { secret, s } = await withMfa(u);
    fakes.notices.length = 0;
    const res = await call('/mfa/recovery-codes/regenerate', {
      json: { password: u.password, code: await totpAt(secret) },
      bearer: s.body.access_token,
    });
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare(
      `SELECT event, user_id, email, actor, detail FROM admin_audit WHERE user_id = ?1`
    )
      .bind(u.id)
      .all<{ event: string; user_id: string; email: string; actor: string; detail: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      event: 'mfa_recovery_codes_regenerated',
      user_id: u.id,
      email: u.email.toLowerCase(),
      actor: 'self',
    });
    const { data } = (await res.json()) as { data: { backupCodes: string[] } };
    for (const c of data.backupCodes) expect(JSON.stringify(rows.results)).not.toContain(c);
    expect(fakes.notices).toEqual([
      expect.objectContaining({ to: u.email, kind: 'recovery_codes_changed' }),
    ]);
  });

  it('a refused step-up leaves no audit row and sends no notice', async () => {
    const u = await seedUser();
    const { s } = await withMfa(u);
    fakes.notices.length = 0;
    const res = await call('/mfa/recovery-codes/regenerate', {
      json: { password: u.password, code: '000000' },
      bearer: s.body.access_token,
    });
    expect(res.status).toBe(400);
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM admin_audit WHERE user_id = ?1`)
      .bind(u.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect(fakes.notices).toEqual([]);
  });
});

describe('A23 review follow-ups', () => {
  it('a malformed or null backup-code column reads as 0 left, not a 500', async () => {
    const u = await seedUser();
    const { s } = await withMfa(u);
    for (const bad of ['not json', 'null', '{"a":1}']) {
      await env.DB.prepare(`UPDATE users SET mfa_backup_codes = ?2 WHERE id = ?1`)
        .bind(u.id, bad)
        .run();
      const res = await call('/mfa/recovery-codes', { bearer: s.body.access_token });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { remaining: number } }).data.remaining).toBe(0);
    }
  });

  it('an account without MFA gets 409 before any password check (no password-guess feedback)', async () => {
    const u = await seedUser();
    const s = await login(u);
    const res = await call('/mfa/recovery-codes/regenerate', {
      json: { password: 'nope', code: '123456' },
      bearer: s.body.access_token,
    });
    expect(res.status).toBe(409);
  });
});
