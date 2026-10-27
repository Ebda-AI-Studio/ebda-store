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
          create: async (args: unknown) => (txLog.push({ tx, op: 'user.create', args }), {}),
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
const identity = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  /** When set, the identity service answers with THIS id instead of the one it was asked to use. */
  forceId: null as string | null,
}));
vi.mock('@api/lib/identity-client', () => ({
  createIdentity: async (input: Record<string, unknown>) => {
    identity.calls.push(input);
    return { id: identity.forceId ?? (input.id as string) };
  },
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
  identity.calls.length = 0;
  identity.forceId = null;
  txLog.length = 0;
  state.existing = null;
});

describe('identity binding (Ruling SIGNUP-TAKEOVER-1)', () => {
  const input = () => merchantSignupSchema.parse({ ...base, acceptedLegal: true });

  it('asks the identity service for an id it generated and writes the profile under exactly that id', async () => {
    await MerchantSignupService.signup(input(), { ip: '203.0.113.9', userAgent: 'UA/1' });
    const asked = identity.calls[0].id as string;
    expect(asked).toMatch(/^[0-9a-f-]{36}$/);
    const create = txLog.find(l => l.op === 'user.create')!;
    expect(create.args.data.id).toBe(asked);
  });

  it('creates NO profile row and NO legal acceptance when the identity answers with a different id', async () => {
    identity.forceId = '00000000-0000-4000-8000-000000000bad';
    const result = await MerchantSignupService.signup(input(), { ip: '203.0.113.9' });
    expect(txLog).toEqual([]);
    // the caller cannot tell: the body is the same generic result as a normal signup
    expect(result).toEqual({ emailVerificationSent: true });
  });
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
    const update = txLog.find(l => l.op === 'user.create')!;
    const create = txLog.find(l => l.op === 'legalAcceptance.createMany')!;
    expect(create.tx).toBe(update.tx);
    expect(create.args.skipDuplicates).toBe(true);
    const rows = create.args.data as Array<Record<string, unknown>>;
    expect(rows.map(r => r.docKey).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        userId: identity.calls[0].id,
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
    expect(txLog.some(l => l.op === 'user.create')).toBe(false);
    // ...but the identity service WAS asked to re-register the address, with the id of the existing row
    expect(identity.calls.at(-1)).toMatchObject({ id: 'u-existing', password: 'Str0ng!Passw0rd' });
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
