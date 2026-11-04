// Opus review of 7d03ec0cd, finding 1: on a DO-served store the password alone must never unlock passkey step-up for an MFA
// account (the Postgres path also demands the TOTP code); login for such an account is refused too.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const h = vi.hoisted(() => ({
  profile: { current: null as Record<string, unknown> | null },
  calls: [] as string[],
  stepUp: [] as string[],
}));
vi.mock('@api/lib/customer-auth', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/customer-auth')>()),
  customerAuthRoute: async (storeId: string | null | undefined) =>
    storeId
      ? {
          kind: 'do',
          client: {
            storeId,
            call: async (op: string) => {
              h.calls.push(op);
              if (op === 'getProfile') return h.profile.current;
              if (op === 'credentialById') return { id: 'u1', hash: bcrypt.hashSync('x', 4) };
              return {};
            },
          },
        }
      : { kind: 'pg' },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () => ({
      setex: async (k: string) => void h.stepUp.push(k),
      get: async () => null,
      del: async () => 0,
    }),
    isAvailable: () => false,
  },
}));
vi.mock('@api/services/login-gate', () => ({
  loginGate: {
    lockoutKey: (e: string, s: string) => `${s}:${e}`,
    assertNotLocked: async () => undefined,
    recordFailure: async () => ({ locked: false }),
    recordSuccess: async () => undefined,
    assertActive: () => undefined,
  },
}));

import { PasskeyService } from '@api/services/passkey.service';

const S = '11111111-1111-4111-8111-111111111111';
const base = { id: 'u1', email: 'a@x.com', status: 'active', deletedAt: null, mfaEnabled: false };
beforeEach(() => {
  h.calls.length = 0;
  h.stepUp.length = 0;
});

describe('DO passkey step-up (Ruling NZ-N9-1)', () => {
  it('a plain account: the password (verified in the Worker) opens the step-up window', async () => {
    h.profile.current = base;
    await expect(
      PasskeyService.stepUp('u1', 'sess', { password: 'x' }, '1.1.1.1', S)
    ).resolves.toMatchObject({ expiresInSeconds: 300 });
    expect(h.calls).toContain('credentialById'); // the compare ran in the Worker
    expect(h.stepUp).toHaveLength(1);
  });
  it('an MFA account: 409 MFA_UNAVAILABLE, the password is never even checked, no window opens', async () => {
    h.profile.current = { ...base, mfaEnabled: true };
    await expect(
      PasskeyService.stepUp('u1', 'sess', { password: 'x' }, '1.1.1.1', S)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MFA_UNAVAILABLE',
    });
    expect(h.calls).not.toContain('credentialById');
    expect(h.stepUp).toHaveLength(0);
  });
});
