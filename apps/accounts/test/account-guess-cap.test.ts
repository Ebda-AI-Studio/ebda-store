/** Issue 618: guesses are counted atomically BEFORE they are evaluated, per address bucket AND per account. */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { call, seedUser } from './helpers';
import { ACCOUNT_CAP, hit, LOGIN } from '../src/throttle';
import { issueOtp, verifyOtp } from '../src/otp';

const login = (email: string, password: string, ip: string) =>
  call('/login', { json: { email, password }, headers: { 'cf-connecting-ip': ip } });

describe('issue 618: concurrent guesses are capped before evaluation', () => {
  it('N parallel wrong passwords from N different networks: at most ACCOUNT_CAP are evaluated', async () => {
    const u = await seedUser();
    const N = ACCOUNT_CAP + 40;
    const res = await Promise.all(
      Array.from({ length: N }, (_, i) => login(u.email, `wrong-${i}`, `203.${i}.7.1`))
    );
    const codes = res.map(r => r.status);
    expect(codes.filter(c => c === 401).length).toBeLessThanOrEqual(ACCOUNT_CAP);
    expect(codes.filter(c => c === 429).length).toBeGreaterThanOrEqual(40);
  });

  it('many addresses inside one IPv6 /64 share one budget (5 per account), not one each', async () => {
    const u = await seedUser();
    const res = await Promise.all(
      Array.from({ length: 30 }, (_, i) => login(u.email, `wrong-${i}`, `2001:db8:1:2::${i + 1}`))
    );
    expect(res.filter(r => r.status === 401).length).toBeLessThanOrEqual(5);
  });

  it('the reset/verify code: K parallel guesses get at most 5 comparisons, and the 6th try cannot succeed', async () => {
    const u = await seedUser();
    const code = (await issueOtp(env.DB, { id: u.id }, 'password_reset'))!;
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await Promise.all(
      Array.from({ length: 25 }, () => verifyOtp(env.DB, { id: u.id }, 'password_reset', wrong))
    );
    expect(res.every(r => !r.ok)).toBe(true);
    const row = await env.DB.prepare(
      `SELECT attempts, used_at FROM verification_tokens WHERE user_id = ?1 AND type = 'password_reset'`
    )
      .bind(u.id)
      .first<{ attempts: number; used_at: string | null }>();
    expect(row!.attempts).toBe(5); // 25 requests, 5 claims: the other 20 were refused unevaluated
    expect(row!.used_at).not.toBeNull(); // the 5th claim burned the code
    expect((await verifyOtp(env.DB, { id: u.id }, 'password_reset', code)).ok).toBe(false);
  });

  it('a correct code still works within its attempts', async () => {
    const u = await seedUser();
    const code = (await issueOtp(env.DB, { id: u.id }, 'password_reset'))!;
    const wrong = code === '000000' ? '111111' : '000000';
    await verifyOtp(env.DB, { id: u.id }, 'password_reset', wrong);
    expect((await verifyOtp(env.DB, { id: u.id }, 'password_reset', code)).ok).toBe(true);
  });
});

describe('issue 664: a refused address never claims an account slot', () => {
  const key = 'victim-664@example.com';
  const acctRows = async () =>
    (await env.DB.prepare(`SELECT count(*) AS n FROM login_attempts WHERE key = ?1`)
      .bind(`a:login:${key}`)
      .first<{ n: number }>())!.n;

  it('the account statement of a request refused by its own address inserts nothing (decided inside the batch)', async () => {
    for (let i = 0; i < 5; i++)
      expect((await hit(env.DB, key, '203.0.113.9', LOGIN)).ok).toBe(true);
    const seen: Array<Array<{ results: unknown[] }>> = [];
    const spy = {
      prepare: (q: string) => env.DB.prepare(q),
      batch: async (st: D1PreparedStatement[]) => {
        const r = (await env.DB.batch(st)) as unknown as Array<{ results: unknown[] }>;
        seen.push(r);
        return r;
      },
    } as unknown as D1Database;
    expect((await hit(spy, key, '203.0.113.9', LOGIN)).ok).toBe(false); // pair budget spent
    expect(seen[0][2].results).toEqual([]); // no account slot was claimed, not even briefly
  });

  it('one locked-out address firing 100 parallel requests leaves the account its capacity', async () => {
    for (let i = 0; i < 5; i++) await hit(env.DB, key, '203.0.113.9', LOGIN);
    const before = await acctRows();
    const res = await Promise.all(
      Array.from({ length: 100 }, () => hit(env.DB, key, '203.0.113.9', LOGIN))
    );
    expect(res.every(a => !a.ok)).toBe(true);
    expect(await acctRows()).toBe(before);
    expect((await hit(env.DB, key, '198.51.100.30', LOGIN)).ok).toBe(true); // the owner is not locked out
  });
});
