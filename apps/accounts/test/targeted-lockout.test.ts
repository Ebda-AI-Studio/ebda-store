/** M-066: typing wrong passwords against a victim's email must not lock the victim out (Ruling M066-1). */
import { describe, it, expect } from 'vitest';
import { call, seedUser } from './helpers';
import { brakeDelayMs, BRAKE_FREE } from '../src/throttle';

const login = (email: string, password: string, ip: string) =>
  call('/login', { json: { email, password }, headers: { 'cf-connecting-ip': ip } });

describe('M-066: no attacker-controlled account lock', () => {
  it('5 wrong passwords from an attacker address do not lock the real owner signing in from elsewhere', async () => {
    const u = await seedUser();
    for (let i = 0; i < 6; i++)
      expect((await login(u.email, `wrong-${i}`, '203.0.113.7')).status).toBeLessThanOrEqual(429);
    // the attacker's own address is refused for that account, even with the right password
    expect((await login(u.email, u.password, '203.0.113.7')).status).toBe(429);
    // the owner, from a different address, still gets in
    expect((await login(u.email, u.password, '198.51.100.20')).status).toBe(200);
  });

  it('failures spread over many addresses are all evaluated (slowed, not refused)', async () => {
    const u = await seedUser();
    const codes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => login(u.email, `wrong-${i}`, `198.19.${i}.1`))
    );
    expect(codes.every(r => r.status === 401)).toBe(true);
    expect((await login(u.email, u.password, '198.51.100.21')).status).toBe(200);
  });
});

describe('M-066: the progressive delay', () => {
  it('is zero up to BRAKE_FREE attempts, then doubles, and is capped', () => {
    expect(brakeDelayMs(BRAKE_FREE, 100)).toBe(0);
    expect(brakeDelayMs(BRAKE_FREE + 1, 100)).toBe(100);
    expect(brakeDelayMs(BRAKE_FREE + 2, 100)).toBe(200);
    expect(brakeDelayMs(BRAKE_FREE + 3, 100)).toBe(400);
    expect(brakeDelayMs(1000, 100)).toBe(8000);
  });
});
