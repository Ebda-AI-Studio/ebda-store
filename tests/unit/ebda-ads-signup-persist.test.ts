/**
 * Ebda own-ads tracking: the signup request persists attribution on the new user, only when
 * the visitor consented, and the schema bounds what a client may send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updates } = vi.hoisted(() => ({
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash', compare: async () => false } }));
vi.mock('@ebda/database', () => ({
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: {
        findUnique: async () => null,
        // The profile row is CREATED by the Store now (the credential lives in the identity service).
        create: async (a: { data: Record<string, unknown> }) => {
          updates.push({ where: undefined, data: a.data });
          return {};
        },
      },
      legalAcceptance: { createMany: async () => ({ count: 5 }) },
    }),
}));
vi.mock('@api/lib/definer', () => ({
  findUserIdByEmail: async () => null,
  ensureAdminUser: async () => ({
    created: true,
    id: 'u1',
    email: 'a@b.co',
    firstName: 'A',
    lastName: 'B',
  }),
}));
vi.mock('@api/lib/identity-client', () => ({
  createIdentity: async () => ({ id: 'u1' }),
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { sendVerificationEmail: async () => undefined },
}));
vi.mock('@api/services/platform-mailer', () => ({
  sendMerchantDuplicateSignupNotice: async () => undefined,
}));

import { MerchantSignupService, merchantSignupSchema } from '@api/services/merchant-signup.service';

const base = {
  email: 'a@b.co',
  name: 'Mona Ali',
  password: 'Str0ng!Passw0rd',
  phone: '01012345678',
  language: 'ar' as const,
  acceptedLegal: true as const,
};
const tracking = {
  attribution: { first_seen: 1, utm_source: 'meta', utm_campaign: 'launch', fbclid: 'abc' },
  fbp: 'fb.1.1.2',
  consent: { analytics: true, marketing: true },
};

beforeEach(() => {
  updates.length = 0;
});

describe('signup persists acquisition', () => {
  it('stores attribution, consent and the server-observed ip/ua on the new user', async () => {
    await MerchantSignupService.signup(merchantSignupSchema.parse({ ...base, tracking }), {
      ip: '203.0.113.9',
      userAgent: 'UA/1',
    });
    const acq = updates[0].data.acquisition as Record<string, unknown>;
    expect(acq).toMatchObject({
      v: 1,
      attribution: { utm_source: 'meta', utm_campaign: 'launch', fbclid: 'abc' },
      fbp: 'fb.1.1.2',
      consent: { analytics: true, marketing: true },
      ip: '203.0.113.9',
      ua: 'UA/1',
    });
  });
  it('without tracking (or after a decline) writes no acquisition column', async () => {
    await MerchantSignupService.signup(merchantSignupSchema.parse(base), { ip: '203.0.113.9' });
    await MerchantSignupService.signup(
      merchantSignupSchema.parse({
        ...base,
        tracking: { consent: { analytics: false, marketing: false } },
      }),
      { ip: '203.0.113.9' }
    );
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.data).not.toHaveProperty('acquisition');
    expect(updates[0].data).toMatchObject({ phone: '+201012345678', language: 'ar' });
  });
  it('bounds what a client can send', () => {
    expect(
      merchantSignupSchema.safeParse({
        ...base,
        tracking: { consent: { analytics: 'yes', marketing: true } },
      }).success
    ).toBe(false);
    expect(
      merchantSignupSchema.safeParse({
        ...base,
        tracking: { fbp: 'x'.repeat(500), consent: { analytics: true, marketing: true } },
      }).success
    ).toBe(false);
  });
});

describe('erasure clears acquisition', () => {
  it('eraseAccount nulls users.acquisition in the anonymising write', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('apps/api/src/services/auth.service.ts', 'utf8');
    const write = src.slice(src.indexOf('const erased = await tx.user.update'));
    expect(write.slice(0, 900)).toContain('acquisition: Prisma.DbNull');
  });
});
