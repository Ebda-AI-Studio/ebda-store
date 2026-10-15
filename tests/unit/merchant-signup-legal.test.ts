/**
 * Signup click-wrap (Ruling LEGAL-4): the API refuses a signup that did not accept the
 * policies, and records the CURRENT version of all five documents in the SAME transaction
 * as the new account's profile write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { txLog, state } = vi.hoisted(() => ({
  txLog: [] as Array<{ tx: number; op: string; args: any }>,
  state: { existing: null as null | Record<string, unknown> },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash', compare: async () => false } }));
vi.mock('@ebda/database', () => {
  let n = 0;
  return {
    withUser: async (_id: string, fn: (tx: unknown) => unknown) => {
      const tx = ++n;
      return fn({
        user: {
          findUnique: async () => state.existing,
          update: async (args: unknown) => (txLog.push({ tx, op: 'user.update', args }), {}),
        },
        verificationToken: { findFirst: async () => null },
        legalAcceptance: {
          createMany: async (args: unknown) => (
            txLog.push({ tx, op: 'legalAcceptance.createMany', args }),
            { count: 5 }
          ),
        },
      });
    },
  };
});
vi.mock('@api/lib/definer', () => ({
  findUserIdByEmail: async () => (state.existing ? 'u-existing' : null),
  ensureAdminUser: async () => ({
    created: true,
    id: 'u1',
    email: 'a@b.co',
    firstName: 'A',
    lastName: 'B',
  }),
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { sendVerificationEmail: async () => undefined },
}));
vi.mock('@api/services/platform-mailer', () => ({
  sendMerchantDuplicateSignupNotice: async () => undefined,
}));

import { MerchantSignupService, merchantSignupSchema } from '@api/services/merchant-signup.service';
import { LEGAL_UA_MAX, signupAcceptanceRows } from '@api/services/legal-notice.service';
import { LEGAL_DOC_KEYS, LEGAL_POLICIES, currentLegalVersion } from '@ebda/shared';

const base = {
  email: 'a@b.co',
  name: 'Mona Ali',
  password: 'Str0ng!Passw0rd',
  phone: '01012345678',
  language: 'ar' as const,
};

beforeEach(() => {
  txLog.length = 0;
  state.existing = null;
});

describe('signup click-wrap', () => {
  it('the schema refuses a missing or false acceptedLegal', () => {
    expect(merchantSignupSchema.safeParse(base).success).toBe(false);
    expect(merchantSignupSchema.safeParse({ ...base, acceptedLegal: false }).success).toBe(false);
    expect(merchantSignupSchema.safeParse({ ...base, acceptedLegal: 'true' }).success).toBe(false);
    expect(merchantSignupSchema.safeParse({ ...base, acceptedLegal: true }).success).toBe(true);
  });

  it('records the current version of all five documents in the profile transaction', async () => {
    await MerchantSignupService.signup(
      merchantSignupSchema.parse({ ...base, acceptedLegal: true }),
      { ip: '203.0.113.9', userAgent: 'UA/1' }
    );
    const update = txLog.find(l => l.op === 'user.update')!;
    const create = txLog.find(l => l.op === 'legalAcceptance.createMany')!;
    expect(create.tx).toBe(update.tx);
    expect(create.args.skipDuplicates).toBe(true);
    const rows = create.args.data as Array<Record<string, unknown>>;
    expect(rows.map(r => r.docKey).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        userId: 'u1',
        version: currentLegalVersion(LEGAL_POLICIES, r.docKey as never).version,
        ip: '203.0.113.9',
        userAgent: 'UA/1',
        source: 'signup',
      });
    }
  });

  it('writes NO acceptance on the unverified-resend path (ownership is unproven)', async () => {
    state.existing = {
      id: 'u-existing',
      email: 'a@b.co',
      firstName: 'A',
      lastName: 'B',
      role: 'store_admin',
      emailVerified: false,
      language: 'ar',
    };
    await MerchantSignupService.signup(
      merchantSignupSchema.parse({ ...base, acceptedLegal: true }),
      { ip: '203.0.113.9', userAgent: 'UA/2' }
    );
    // Neither the new-account profile write nor ANY legal_acceptances operation ran, so the
    // owner's original rows are untouched.
    expect(txLog.filter(l => l.op.startsWith('legalAcceptance'))).toEqual([]);
    expect(txLog.some(l => l.op === 'user.update')).toBe(false);
  });

  it('never splits a surrogate pair when truncating the user-agent', () => {
    const ua = 'x'.repeat(LEGAL_UA_MAX - 1) + '\u{1F600}tail';
    const [row] = signupAcceptanceRows('u1', { userAgent: ua });
    const stored = row.userAgent as string;
    expect(Array.from(stored)).toHaveLength(LEGAL_UA_MAX);
    expect(stored.endsWith('\u{1F600}')).toBe(true);
    expect(stored).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
  });

  it('the shared row builder truncates a long user-agent and nulls absent ip/UA', () => {
    const long = 'x'.repeat(LEGAL_UA_MAX + 50);
    const [row] = signupAcceptanceRows('u1', { userAgent: long });
    expect(row.userAgent).toHaveLength(LEGAL_UA_MAX);
    expect(row.ip).toBeNull();
    expect(signupAcceptanceRows('u1', {})[0].userAgent).toBeNull();
  });
});
