/**
 * The ONE eligibility rule behind the policy-change banner AND "Got it" (Ruling LEGAL-4, A6):
 * a document's current version is noticeable only when it is MATERIAL and SENT. Imported from
 * `@ebda/shared/legal` (the SOURCE, not the built dist) so `npm run test:defence-mutations`
 * sees a mutation of it (entry consent-legal-ack-material-only). The HTTP twin is the I3 case
 * in tests/integration/legal-notices.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  LEGAL_POLICIES,
  computePendingNotices,
  isNoticeable,
  noticeableVersions,
  type LegalPolicies,
} from '@ebda/shared/legal';

const sentPrivacy = [{ docKey: 'privacy', version: '1.0' }];

describe('legal notice eligibility (material AND sent)', () => {
  it('a SENT but non-material current version is not noticeable, not ackable, not pending', () => {
    const cur = LEGAL_POLICIES.privacy.history[0];
    expect(cur.material).toBe(false);
    expect(isNoticeable(cur, 'privacy', sentPrivacy)).toBe(false);
    expect(noticeableVersions(LEGAL_POLICIES, sentPrivacy)).toEqual([]);
    expect(computePendingNotices(LEGAL_POLICIES, sentPrivacy, [])).toEqual([]);
  });

  it('the same version marked material and sent IS noticeable (the rule is not just "never")', () => {
    const material: LegalPolicies = {
      ...LEGAL_POLICIES,
      privacy: { history: [{ ...LEGAL_POLICIES.privacy.history[0], material: true }] },
    };
    expect(noticeableVersions(material, sentPrivacy)).toEqual([
      { docKey: 'privacy', version: '1.0' },
    ]);
    expect(noticeableVersions(material, [])).toEqual([]);
  });
});

describe('maskIp (super-admin acceptance evidence, I6)', () => {
  it('keeps the network, never the host', async () => {
    const { maskIp } = await import('@api/lib/pii-mask');
    expect(maskIp('203.0.113.45')).toBe('203.0.113.*');
    expect(maskIp('::ffff:203.0.113.45')).toBe('203.0.113.*');
    expect(maskIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2:*');
    expect(maskIp('garbage')).toBe('*');
    expect(maskIp('')).toBeNull();
    expect(maskIp(null)).toBeNull();
  });
});

describe('baseline acceptance gate (Ruling LEGAL-BASELINE-1)', () => {
  it('a merchant with no acceptance rows (staff-invited, never through the signup wrap) is asked for every document', () => {
    const out = computePendingNotices(LEGAL_POLICIES, [], [], { requireBaseline: true });
    expect(out.map(n => n.docKey).sort()).toEqual(
      ['acceptableUse', 'legal', 'merchant', 'privacy', 'terms'].sort()
    );
  });

  it('the API asks for the baseline AND lets "Got it" record it (fails if either wire is cut)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('apps/api/src/services/legal-notice.service.ts', 'utf8');
    expect(src).toMatch(
      /computePendingNotices\(activePolicies, sent, accepted, \{\s*requireBaseline: true/
    );
    expect(src).toMatch(/\.\.\.baselineMissing\(activePolicies, accepted\)/);
  });
});
