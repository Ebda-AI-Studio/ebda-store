import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM script module
import {
  evaluateSoak,
  scanLegacySignIn,
  stripComments,
} from '../../scripts/ops/identity-soak-lib.mjs';

const ok = {
  windowDays: 8,
  minWindowDays: 7,
  hs256AdminLogins: 0,
  superAdmins: [{ email: 'a@example.com', mfaEnabled: true, passkeys: 0 }],
  legacySignInRefs: [],
  liveLegacyRefresh: 0,
};

describe('evaluateSoak', () => {
  it('passes only when all four criteria hold', () => {
    const r = evaluateSoak(ok);
    expect(r.pass).toBe(true);
    expect(r.criteria).toHaveLength(4);
  });

  it.each([
    ['a legacy admin login in the window', { hs256AdminLogins: 1 }, 'noHs256AdminLogins'],
    ['a window shorter than the minimum', { windowDays: 3 }, 'noHs256AdminLogins'],
    ['an unmeasured login count', { hs256AdminLogins: undefined }, 'noHs256AdminLogins'],
    [
      'a super-admin with no second factor',
      { superAdmins: [{ email: 'a@x.com', mfaEnabled: false, passkeys: 0 }] },
      'superAdminSecondFactor',
    ],
    ['no super-admin at all', { superAdmins: [] }, 'superAdminSecondFactor'],
    ['an unreachable identity D1', { superAdmins: undefined }, 'superAdminSecondFactor'],
    [
      'a Store sign-in call in the admin app',
      { legacySignInRefs: ['apps/admin/src/a.ts:1: x'] },
      'adminSignInViaAccountsOnly',
    ],
    ['sources not scanned', { legacySignInRefs: undefined }, 'adminSignInViaAccountsOnly'],
    ['a live legacy admin refresh token', { liveLegacyRefresh: 2 }, 'noLegacyAdminRefresh'],
    ['an unmeasured refresh count', { liveLegacyRefresh: undefined }, 'noLegacyAdminRefresh'],
  ])('refuses on %s', (_n, over, failing) => {
    const r = evaluateSoak({ ...ok, ...over });
    expect(r.pass).toBe(false);
    expect(r.criteria.find((c: { id: string }) => c.id === failing).pass).toBe(false);
  });

  it('a passkey counts as a second factor', () => {
    expect(
      evaluateSoak({ ...ok, superAdmins: [{ email: 'a@x.com', mfaEnabled: false, passkeys: 1 }] })
        .pass
    ).toBe(true);
  });
});

describe('scanLegacySignIn', () => {
  it('finds calls to the Store sign-in endpoints but ignores comments', () => {
    const hits = scanLegacySignIn([
      {
        path: 'a.ts',
        text: "// POST '/auth/login' is gone\nconst r = await fetch(`${api}/auth/me`);\nfetch(apiUrl + '/auth/refresh', {})",
      },
      { path: 'b.ts', text: "/* '/auth/mfa/verify' */ post('/auth/passkey/login/options')" },
      { path: 'c.ts', text: "fetch('/auth/me'); fetch('/auth/logout')" },
    ]);
    expect(hits.map((h: string) => h.split(':')[0])).toEqual(['a.ts', 'b.ts']);
  });
  it('stripComments keeps URLs', () => {
    expect(stripComments("const u = 'https://accounts.ebda.app'; // note")).toContain(
      'https://accounts.ebda.app'
    );
  });
});

// @ts-expect-error plain ESM script module
import { stage5Problems } from '../../scripts/ci/stage5-guard.mjs';

describe('stage5Problems (the merge guard)', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const report = {
    pass: true,
    generatedAt: '2026-11-05T09:00:00Z',
    criteria: [{ pass: true }, { pass: true }, { pass: true }, { pass: true }],
  };
  const approval = { approvedBy: 'Ahmad Sharaf', approvedAt: '2026-11-05T10:00:00Z' };

  it('lets the merge through only with a fresh passing report and Ahmad after it', () => {
    expect(stage5Problems({ report, approval, now })).toEqual([]);
  });
  it.each([
    ['no report', { report: undefined, approval }],
    ['no approval', { report, approval: undefined }],
    ['a failing report', { report: { ...report, pass: false }, approval }],
    [
      'one failing criterion',
      {
        report: {
          ...report,
          criteria: [{ pass: true }, { pass: false }, { pass: true }, { pass: true }],
        },
        approval,
      },
    ],
    [
      'a stale report',
      {
        report: { ...report, generatedAt: '2026-11-02T09:00:00Z' },
        approval: { ...approval, approvedAt: '2026-11-05T10:00:00Z' },
      },
    ],
    ['someone else approving', { report, approval: { ...approval, approvedBy: 'Claude' } }],
    [
      'an approval older than the report',
      { report, approval: { ...approval, approvedAt: '2026-11-05T08:00:00Z' } },
    ],
  ])('refuses on %s', (_n, input) => {
    expect(stage5Problems({ ...input, now }).length).toBeGreaterThan(0);
  });
});
