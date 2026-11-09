import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

const gate = vi.hoisted(() => ({
  lockoutKey: vi.fn((e: string, s: string | null) => `${s}:${e}`),
  assertNotLocked: vi.fn(async () => undefined),
  recordFailure: vi.fn(async () => ({ locked: false })),
  recordSuccess: vi.fn(async () => undefined),
  assertActive: vi.fn(),
}));
vi.mock('../login-gate', () => ({ loginGate: gate }));
vi.mock('../email.service', () => ({ EmailService: {} }));
vi.mock('../session-tokens', () => ({
  signAccessToken: () => 'a',
  signRefreshToken: () => 'r',
  REFRESH_ROW_DAYS: 30,
}));

import { CustomerAuthFlows, type DoCustomer } from '../customer-auth-flows';

const user = (emailVerified: boolean) =>
  ({
    id: 'u1',
    email: 'a@b.co',
    firstName: 'A',
    lastName: 'B',
    status: 'active',
    deletedAt: null,
    emailVerified,
    tokenVersion: 0,
  }) as unknown as DoCustomer;

function client(verified: boolean) {
  const hash = bcrypt.hashSync('Correct-Pass-1', 4);
  return {
    storeId: 's1',
    call: vi.fn(async (op: string) => {
      if (op === 'credential') return { id: 'u1', hash, tokenVersion: 0 };
      if (op === 'loginSucceeded') return { user: user(verified), mfa: false };
      return {};
    }),
  } as never;
}

describe('customer login on an unverified email', () => {
  beforeEach(() => vi.clearAllMocks());

  it('correct password + unverified => 403 EMAIL_NOT_VERIFIED, counters reset as for any correct password', async () => {
    await expect(
      CustomerAuthFlows.login(client(false), 'a@b.co', 'Correct-Pass-1')
    ).rejects.toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED' });
    expect(gate.recordSuccess).toHaveBeenCalledTimes(1);
    expect(gate.recordFailure).not.toHaveBeenCalled();
  });

  it('wrong password + unverified => the generic 401 INVALID_CREDENTIALS (no oracle), failure counted', async () => {
    await expect(
      CustomerAuthFlows.login(client(false), 'a@b.co', 'Wrong-Pass-1')
    ).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    expect(gate.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('correct password + verified still signs in', async () => {
    const r = await CustomerAuthFlows.login(client(true), 'a@b.co', 'Correct-Pass-1');
    expect(r.accessToken).toBe('a');
  });
});
