/**
 * Ruling LEGAL-4: the legal-policy registry is the single source of each document's version,
 * dates and material/fee flags. These invariants are what make "we will notify merchants of
 * material changes" and the Terms' 30-day fee-change promise checkable at PR time.
 */
import { describe, it, expect } from 'vitest';
import {
  LEGAL_DOC_KEYS,
  LEGAL_POLICIES,
  LEGAL_DOC_SLUG,
  compareLegalVersions,
  computePendingNotices,
  feeNoticeTooLate,
  isNoticeable,
  currentLegalVersion,
  findLegalVersion,
  formatLegalDate,
  legalPolicyUrl,
  validateLegalPolicies,
  type LegalPolicies,
  type LegalVersion,
} from '../legal';

const v = (over: Partial<LegalVersion> = {}): LegalVersion => ({
  version: '1.0',
  publishedAt: '2026-10-07',
  effectiveAt: '2026-10-07',
  material: false,
  feeChange: false,
  summary: { ar: 'الإصدار الأول.', en: 'First version.' },
  ...over,
});
const withTerms = (history: LegalVersion[]): LegalPolicies => ({
  ...LEGAL_POLICIES,
  terms: { history },
});

describe('LEGAL_POLICIES (the shipped registry)', () => {
  it('passes every invariant', () => {
    expect(validateLegalPolicies(LEGAL_POLICIES)).toEqual([]);
  });
  it('is frozen, and no two documents share a version or summary object (M4)', () => {
    expect(Object.isFrozen(LEGAL_POLICIES)).toBe(true);
    const entries = LEGAL_DOC_KEYS.map(k => LEGAL_POLICIES[k].history[0]);
    for (const e of entries) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.summary)).toBe(true);
    }
    expect(new Set(entries).size).toBe(LEGAL_DOC_KEYS.length);
    expect(new Set(entries.map(e => e.summary)).size).toBe(LEGAL_DOC_KEYS.length);
    expect(() => {
      (LEGAL_POLICIES.terms.history[0].summary as { en: string }).en = 'x';
    }).toThrow(TypeError);
  });

  it('has an entry for every document key and nothing else', () => {
    expect(Object.keys(LEGAL_POLICIES).sort()).toEqual([...LEGAL_DOC_KEYS].sort());
    for (const k of LEGAL_DOC_KEYS) expect(LEGAL_POLICIES[k].history.length).toBeGreaterThan(0);
  });
});

describe('validateLegalPolicies', () => {
  it('flags a missing document', () => {
    const rest: Record<string, { history: readonly LegalVersion[] }> = { ...LEGAL_POLICIES };
    delete rest.privacy;
    expect(validateLegalPolicies(rest)).toContain('privacy: no entry');
  });
  it('flags an unknown document key', () => {
    expect(validateLegalPolicies({ ...LEGAL_POLICIES, cookies: { history: [v()] } })).toContain(
      'cookies: unknown document'
    );
  });
  it('flags a version that is not newer than the previous one', () => {
    const errors = validateLegalPolicies(withTerms([v(), v({ version: '1.0' })]));
    expect(errors).toContain('terms@1.0: not newer than 1.0');
  });
  it('orders versions numerically (1.10 is newer than 1.9)', () => {
    expect(compareLegalVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(
      validateLegalPolicies(
        withTerms([
          v({ version: '1.9' }),
          v({ version: '1.10', publishedAt: '2026-10-08', effectiveAt: '2026-10-08' }),
        ])
      )
    ).toEqual([]);
  });
  it('flags a version published before the previous one', () => {
    const errors = validateLegalPolicies(
      withTerms([v(), v({ version: '1.1', publishedAt: '2026-10-01', effectiveAt: '2026-10-01' })])
    );
    expect(errors).toContain('terms@1.1: published before 1.0');
  });
  it("refuses a fee change with less than 30 days' notice, accepts exactly 30", () => {
    const fee = (effectiveAt: string) =>
      v({
        version: '1.1',
        publishedAt: '2026-11-01',
        effectiveAt,
        material: true,
        feeChange: true,
      });
    expect(validateLegalPolicies(withTerms([v(), fee('2026-11-30')]))).toContain(
      "terms@1.1: a fee change needs 30 days' notice"
    );
    expect(validateLegalPolicies(withTerms([v(), fee('2026-12-01')]))).toEqual([]);
  });
  it('refuses a fee change that is not marked material', () => {
    const errors = validateLegalPolicies(
      withTerms([
        v(),
        v({
          version: '1.1',
          publishedAt: '2026-11-01',
          effectiveAt: '2026-12-01',
          feeChange: true,
        }),
      ])
    );
    expect(errors).toContain('terms@1.1: a fee change is always material');
  });
  it('refuses an effective date before the publish date, bad dates and an empty summary', () => {
    const errors = validateLegalPolicies(
      withTerms([
        v({ effectiveAt: '2026-10-06' }),
        v({ version: '1.1', publishedAt: '7 Oct 2026' }),
        v({ version: '1.2', publishedAt: '2026-10-09', summary: { ar: '', en: 'x' } }),
      ])
    );
    expect(errors).toContain('terms@1.0: effectiveAt before publishedAt');
    expect(errors).toContain('terms@1.1: dates must be YYYY-MM-DD');
    expect(errors).toContain('terms@1.2: summary needs ar and en');
  });
});

describe('helpers', () => {
  it('current = last history entry; find by version', () => {
    const p = withTerms([v(), v({ version: '1.1', publishedAt: '2026-10-09' })]);
    expect(currentLegalVersion(p, 'terms').version).toBe('1.1');
    expect(findLegalVersion(p, 'terms', '1.0')?.version).toBe('1.0');
    expect(findLegalVersion(p, 'terms', '9.9')).toBeNull();
    expect(findLegalVersion(p, 'cookies', '1.0')).toBeNull();
  });
  it('formats the date like the published pages, Latin digits, no timezone drift', () => {
    expect(formatLegalDate('2026-10-07', 'en')).toBe('7 October 2026');
    expect(formatLegalDate('2026-10-07', 'ar')).toBe('7 أكتوبر 2026');
    expect(formatLegalDate('2026-10-07', 'ar')).not.toMatch(/[٠-٩]/);
  });
  it('links to the marketing page of each document, per locale', () => {
    expect(legalPolicyUrl('terms', 'ar')).toBe('https://ebda.app/terms/');
    expect(legalPolicyUrl('merchant', 'en')).toBe('https://ebda.app/en/merchant-agreement/');
    expect(LEGAL_DOC_SLUG.acceptableUse).toBe('acceptable-use');
  });
});

describe('computePendingNotices', () => {
  const material = v({
    version: '1.1',
    publishedAt: '2026-11-01',
    effectiveAt: '2026-12-01',
    material: true,
    feeChange: true,
    summary: { ar: 'تغيير في الرسوم.', en: 'Fee change.' },
  });
  const p = withTerms([v(), material]);

  it('nothing is pending until the current material version has been SENT', () => {
    expect(computePendingNotices(p, [], [])).toEqual([]);
  });
  it('a sent, unaccepted current material version is pending, with title and links', () => {
    const out = computePendingNotices(p, [{ docKey: 'terms', version: '1.1' }], []);
    expect(out).toEqual([
      {
        docKey: 'terms',
        version: '1.1',
        effectiveAt: '2026-12-01',
        summary: { ar: 'تغيير في الرسوم.', en: 'Fee change.' },
        title: { ar: 'شروط الخدمة', en: 'Terms of service' },
        url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
      },
    ]);
  });
  it('an accepted version is not pending', () => {
    const sent = [{ docKey: 'terms', version: '1.1' }];
    expect(computePendingNotices(p, sent, sent)).toEqual([]);
  });
  it('a sent NON-material or NON-current version is never pending', () => {
    expect(
      computePendingNotices(LEGAL_POLICIES, [{ docKey: 'privacy', version: '1.0' }], [])
    ).toEqual([]);
    expect(computePendingNotices(p, [{ docKey: 'terms', version: '1.0' }], [])).toEqual([]);
  });
});

describe('baseline acceptance (a merchant invited by staff never clicked the wrap)', () => {
  it('a party with no record at all is pending every document at its current version', () => {
    const out = computePendingNotices(LEGAL_POLICIES, [], [], { baselineDocs: LEGAL_DOC_KEYS });
    expect(out.map(n => n.docKey).sort()).toEqual(
      ['acceptableUse', 'legal', 'merchant', 'privacy', 'terms'].sort()
    );
    expect(out.find(n => n.docKey === 'terms')?.version).toBe(
      currentLegalVersion(LEGAL_POLICIES, 'terms').version
    );
  });
  it('a document with ANY recorded version is not a missing baseline', () => {
    const out = computePendingNotices(LEGAL_POLICIES, [], [{ docKey: 'terms', version: '1.0' }], {
      baselineDocs: LEGAL_DOC_KEYS,
    });
    expect(out.map(n => n.docKey)).not.toContain('terms');
    expect(out.length).toBe(4);
  });
  it('only the asked-for documents count (staff are shown privacy and acceptable use only)', () => {
    const out = computePendingNotices(LEGAL_POLICIES, [], [], {
      baselineDocs: ['privacy', 'acceptableUse'],
    });
    expect(out.map(n => n.docKey).sort()).toEqual(['acceptableUse', 'privacy']);
  });
  it('is off unless asked for, so non-merchant callers see only material notices', () => {
    expect(computePendingNotices(LEGAL_POLICIES, [], [])).toEqual([]);
  });
});

describe('feeNoticeTooLate (I1: 30 days measured from the SEND, not from publishedAt)', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  it('refuses a fee change whose effective date is less than 30 days after the send', () => {
    expect(
      feeNoticeTooLate(v({ feeChange: true, material: true, effectiveAt: '2026-11-13' }), now)
    ).toBe(true);
    expect(
      feeNoticeTooLate(v({ feeChange: true, material: true, effectiveAt: '2026-11-15' }), now)
    ).toBe(false);
  });
  it('never applies to a non-fee change, however close', () => {
    expect(feeNoticeTooLate(v({ material: true, effectiveAt: '2026-10-15' }), now)).toBe(false);
  });
});

describe('isNoticeable (the one eligibility rule for banner and ack)', () => {
  it('needs material AND sent', () => {
    const sent = [{ docKey: 'terms', version: '1.0' }];
    expect(isNoticeable(v({ material: true }), 'terms', sent)).toBe(true);
    expect(isNoticeable(v({ material: false }), 'terms', sent)).toBe(false);
    expect(isNoticeable(v({ material: true }), 'terms', [])).toBe(false);
    expect(isNoticeable(v({ material: true }), 'privacy', sent)).toBe(false);
  });
});
