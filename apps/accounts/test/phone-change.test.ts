/** Ruling PHONE-CHANGE-1: a merchant changes the account phone, behind the same step-up as other recovery-channel changes. */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { call, fakes, login, seedUser } from './helpers';

beforeEach(() => {
  fakes.mails.length = 0;
  fakes.stores = [];
});

const phoneOf = async (id: string) =>
  (await env.DB.prepare(`SELECT phone FROM users WHERE id = ?1`)
    .bind(id)
    .first<{ phone: string | null }>())!.phone;

describe('POST /phone', () => {
  it('changes the phone with the current password, normalised, and /me then shows it', async () => {
    const u = await seedUser();
    const s = await login(u);
    const r = await call('/phone', {
      json: { phone: '+20 100 123-4567', password: u.password },
      bearer: s.body.access_token,
    });
    expect(r.status).toBe(200);
    expect(await phoneOf(u.id)).toBe('+201001234567');
    const me = (await (await call('/me', { bearer: s.body.access_token })).json()) as {
      data: { user: { phone: string | null } };
    };
    expect(me.data.user.phone).toBe('+201001234567');
  });

  it('refuses a wrong password and leaves the phone alone', async () => {
    const u = await seedUser();
    const before = await phoneOf(u.id);
    const s = await login(u);
    const r = await call('/phone', {
      json: { phone: '01001234567', password: 'not-the-password' },
      bearer: s.body.access_token,
    });
    expect(r.status).toBe(403);
    expect(await phoneOf(u.id)).toBe(before);
  });

  it('refuses a malformed number and a missing token', async () => {
    const u = await seedUser();
    const s = await login(u);
    expect(
      (
        await call('/phone', {
          json: { phone: 'call me', password: u.password },
          bearer: s.body.access_token,
        })
      ).status
    ).toBe(400);
    expect(
      (await call('/phone', { json: { phone: '01001234567', password: u.password } })).status
    ).toBe(401);
  });

  it('is throttled per account', async () => {
    const u = await seedUser();
    const s = await login(u);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push(
        (
          await call('/phone', {
            json: { phone: '01001234567', password: 'wrong-password' },
            bearer: s.body.access_token,
          })
        ).status
      );
    expect(codes.filter(x => x === 429).length).toBeGreaterThanOrEqual(1);
  });
});
