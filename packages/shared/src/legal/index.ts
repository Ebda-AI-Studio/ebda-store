/**
 * Ebda Store legal documents: the version of each one that is current, when it was published,
 * when it takes effect, and whether the change was material (Ruling LEGAL-4).
 *
 * The policy TEXT lives in apps/marketing/src/lib/legal-{ar,en}.ts. Publishing a change =
 * edit that text AND append a `history` entry here IN THE SAME PR
 * (docs/runbooks/legal-policy-change.md). The marketing pages render their "last updated" line
 * from this registry; the API uses it to record acceptance at signup and to decide which
 * notices a merchant still has to see.
 *
 * Pure module: it imports only the brand, so the static marketing site can import it via
 * `@ebda/shared/legal` without the shared barrel.
 */
import { BRAND } from '../brand';

export const LEGAL_DOC_KEYS = ['legal', 'privacy', 'terms', 'acceptableUse', 'merchant'] as const;
export type LegalDocKey = (typeof LEGAL_DOC_KEYS)[number];

export interface LegalVersion {
  /** Dotted numbers ("1.0", "1.1"), strictly newer than the previous entry. */
  readonly version: string;
  /** YYYY-MM-DD: shown as "Last updated" on the page. */
  readonly publishedAt: string;
  /** YYYY-MM-DD: when this version binds. A fee change needs >= publishedAt + 30 days. */
  readonly effectiveAt: string;
  /** Material = announced: dashboard banner + email to every store owner. */
  readonly material: boolean;
  /** Affects fees: always material, and 30 days' notice (Terms, "Changes to these terms"). */
  readonly feeChange: boolean;
  /** What changed, one or two sentences, shown in the banner and the email. */
  readonly summary: { readonly ar: string; readonly en: string };
}

export type LegalPolicies = Readonly<
  Record<LegalDocKey, { readonly history: readonly LegalVersion[] }>
>;

/** Days of notice the Terms promise before a fee change takes effect. */
export const LEGAL_FEE_NOTICE_DAYS = 30;

/** A fresh, frozen v1.0 entry per document: no two documents share (or can mutate) one object. */
function firstVersion(): LegalVersion {
  return Object.freeze({
    version: '1.0',
    publishedAt: '2026-10-07',
    effectiveAt: '2026-10-07',
    material: false,
    feeChange: false,
    summary: Object.freeze({ ar: 'الإصدار الأول.', en: 'First version.' }),
  });
}

/** v1.1 (LEGAL-1), dated the day it is published (never backdated; set it to the merge day). No fee changes: prices stay final amounts, no VAT (Ruling VAT-0), so `feeChange` is false and no 30-day notice applies. */
function v11(material: boolean, summary: { ar: string; en: string }): LegalVersion {
  return Object.freeze({
    version: '1.1',
    publishedAt: '2026-10-26',
    effectiveAt: '2026-10-26',
    material,
    feeChange: false,
    summary: Object.freeze(summary),
  });
}

/** v1.2 (SHARIA-AUP-1), published 2026-11-03. No fee change. */
function v12(summary: { ar: string; en: string }): LegalVersion {
  return Object.freeze({
    version: '1.2',
    publishedAt: '2026-11-03',
    effectiveAt: '2026-11-03',
    material: true,
    feeChange: false,
    summary: Object.freeze(summary),
  });
}

const doc = (...history: LegalVersion[]) =>
  Object.freeze({ history: Object.freeze(history) as readonly LegalVersion[] });

/** Oldest first; the LAST entry is the current version. Frozen: the registry is code, not state. */
export const LEGAL_POLICIES: LegalPolicies = Object.freeze({
  legal: doc(
    firstVersion(),
    v11(false, {
      ar: 'بريد مستقل لطلبات الخصوصية وحماية البيانات، وروابط إلى صفحة حذف البيانات ووثائق ابدأ شات.',
      en: 'A separate address for privacy and data-protection requests, and links to the data deletion page and the Ebda Chat documents.',
    })
  ),
  privacy: doc(
    firstVersion(),
    v11(true, {
      ar: 'مسؤول حماية البيانات وبريده privacy@ebda.app، وقائمة الجهات المستلمة خارج مصر، وMeta عند استخدام ابدأ شات، وإخطار الاختراق خلال 72 ساعة، ورابط صفحة حذف البيانات.',
      en: 'Our data protection officer and privacy@ebda.app, the recipients outside Egypt, Meta when Ebda Chat is used, 72-hour breach notice, and a link to the data deletion page.',
    }),
    Object.freeze({
      version: '1.2',
      publishedAt: '2026-11-09',
      effectiveAt: '2026-11-09',
      material: true,
      feeChange: false,
      summary: Object.freeze({
        ar: 'قائمة المزودين محدّثة لتطابق البنية الحالية: Cloudflare معالجًا رئيسيًا للبيانات (قاعدة البيانات والتخزين والطوابير والبريد)، ولم تعد Neon وInngest مستخدمتين. وإفصاح عن أداة تحليلات الويب Cloudflare Web Analytics، وهي لا تستخدم ملفات تعريف ارتباط ولا تتطلب موافقة.',
        en: 'The provider list now matches our current infrastructure: Cloudflare as the main data processor (database, storage, queues and email); Neon and Inngest are no longer used. Disclosure of the Cloudflare Web Analytics beacon, which uses no cookies and needs no consent.',
      }),
    })
  ),
  terms: doc(
    firstVersion(),
    v11(true, {
      ar: 'توضيح أن الأسعار مبالغ نهائية دون ضريبة قيمة مضافة، وإغلاق الحساب بمراسلة privacy@ebda.app، وإشارة إلى شروط ابدأ شات.',
      en: 'Prices are final amounts with no VAT, account closure by writing to privacy@ebda.app, and a pointer to the Ebda Chat terms.',
    })
  ),
  acceptableUse: doc(
    firstVersion(),
    v11(true, {
      ar: 'منتجات ممنوعة عبر ابدأ شات وفق سياسة التجارة في واتساب من Meta.',
      en: "Products that may not be sold through Ebda Chat, following Meta's WhatsApp Commerce Policy.",
    }),
    v12({
      ar: 'حظر الكحوليات ولحم الخنزير، وحظر السحوبات ذات الدخول المدفوع والصناديق الغامضة التي تُباع بالصدفة والتقييمات المزيفة والندرة المزيفة.',
      en: 'Alcohol and pork are banned, as are paid-entry prize draws, mystery boxes sold for chance, fake reviews, and fake scarcity or countdown timers.',
    })
  ),
  merchant: doc(
    firstVersion(),
    v11(true, {
      ar: 'الأسعار مبالغ نهائية دون ضريبة قيمة مضافة، وإخطار التاجر بالاختراق خلال 72 ساعة، وضمانات النقل خارج مصر.',
      en: 'Prices are final amounts with no VAT, notice of a data breach to the merchant within 72 hours, and safeguards for transfers outside Egypt.',
    }),
    v12({
      ar: 'الأحكام الجديدة في سياسة الاستخدام المقبول (الكحوليات ولحم الخنزير والسحوبات المدفوعة والتقييمات المزيفة)، والتقسيط معطّل افتراضيًا، وطلبات الذهب تُدفع كاملة عبر الإنترنت ما لم يغيّر التاجر الإعداد.',
      en: 'The new Acceptable Use Policy bans (alcohol, pork, paid-entry draws, fake reviews), installments off by default, and gold orders paid in full online unless the merchant changes the setting.',
    })
  ),
});

/**
 * Which processor stack the privacy policy's sections 5 and 6 describe (DOC-2). 'current' = Neon, Resend, Inngest and
 * the rest as live today; 'cloudflare' = the post-cutover text (apps/marketing/src/lib/legal-privacy-stack.ts). The
 * cutover PR flips this AND appends a material `privacy` 1.2 entry to LEGAL_POLICIES in the same commit; the policy
 * must change the day the processors do, never before (it would be false) and never after.
 */
export const PRIVACY_STACK: 'current' | 'cloudflare' = 'cloudflare';

/** Document titles, identical to the marketing pages' titles (parity-tested in marketing-site.test.tsx). */
export const LEGAL_DOC_TITLE: Readonly<Record<LegalDocKey, { ar: string; en: string }>> = {
  legal: { ar: 'الإشعار القانوني', en: 'Legal notice' },
  privacy: { ar: 'سياسة الخصوصية', en: 'Privacy policy' },
  terms: { ar: 'شروط الخدمة', en: 'Terms of service' },
  acceptableUse: { ar: 'سياسة الاستخدام المقبول', en: 'Acceptable use policy' },
  merchant: { ar: 'اتفاقية التاجر', en: 'Merchant agreement' },
};

/** Path segment of each document on ebda.app (apps/marketing/src/lib/site.ts LEGAL_SLUGS). */
export const LEGAL_DOC_SLUG: Readonly<Record<LegalDocKey, string>> = {
  legal: 'legal',
  privacy: 'privacy',
  terms: 'terms',
  acceptableUse: 'acceptable-use',
  merchant: 'merchant-agreement',
};

export function isLegalDocKey(x: unknown): x is LegalDocKey {
  return typeof x === 'string' && (LEGAL_DOC_KEYS as readonly string[]).includes(x);
}

export function currentLegalVersion(policies: LegalPolicies, key: LegalDocKey): LegalVersion {
  const h = policies[key].history;
  return h[h.length - 1];
}

export function findLegalVersion(
  policies: LegalPolicies,
  key: string,
  version: string
): LegalVersion | null {
  if (!isLegalDocKey(key)) return null;
  return policies[key].history.find(e => e.version === version) ?? null;
}

/** Numeric compare of dotted versions: > 0 when `a` is newer. */
export function compareLegalVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+(\.\d+)*$/;
const DAY_MS = 86_400_000;
const utc = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`);

/** Every broken invariant as a readable line; `[]` = valid. Enforced by legal-policies.test.ts. */
export function validateLegalPolicies(
  policies: Record<string, { history: readonly LegalVersion[] } | undefined>
): string[] {
  const errors: string[] = [];
  for (const key of LEGAL_DOC_KEYS) {
    const history = policies[key]?.history;
    if (!history || history.length === 0) {
      errors.push(`${key}: no entry`);
      continue;
    }
    history.forEach((e, i) => {
      const at = `${key}@${e.version}`;
      if (!VERSION.test(e.version)) errors.push(`${at}: version must be dotted numbers`);
      if (!ISO_DATE.test(e.publishedAt) || !ISO_DATE.test(e.effectiveAt)) {
        errors.push(`${at}: dates must be YYYY-MM-DD`);
        return;
      }
      const pub = utc(e.publishedAt);
      const eff = utc(e.effectiveAt);
      if (eff < pub) errors.push(`${at}: effectiveAt before publishedAt`);
      if (e.feeChange && !e.material) errors.push(`${at}: a fee change is always material`);
      if (e.feeChange && eff < pub + LEGAL_FEE_NOTICE_DAYS * DAY_MS) {
        errors.push(`${at}: a fee change needs ${LEGAL_FEE_NOTICE_DAYS} days' notice`);
      }
      if (!e.summary.ar.trim() || !e.summary.en.trim())
        errors.push(`${at}: summary needs ar and en`);
      const prev = history[i - 1];
      if (prev) {
        if (compareLegalVersions(e.version, prev.version) <= 0) {
          errors.push(`${at}: not newer than ${prev.version}`);
        }
        if (ISO_DATE.test(prev.publishedAt) && pub < utc(prev.publishedAt)) {
          errors.push(`${at}: published before ${prev.version}`);
        }
      }
    });
  }
  for (const key of Object.keys(policies)) {
    if (!isLegalDocKey(key)) errors.push(`${key}: unknown document`);
  }
  return errors;
}

/**
 * A fee change must reach merchants at least LEGAL_FEE_NOTICE_DAYS before it takes effect
 * (Terms, "Changes to these terms"). The registry checks effectiveAt against publishedAt; this
 * checks it against the moment the notice is actually SENT, so a late "Send notice" cannot
 * shorten the promised window (Ruling LEGAL-5). Non-fee changes have no minimum.
 */
export function feeNoticeTooLate(entry: LegalVersion, now: Date = new Date()): boolean {
  return entry.feeChange && utc(entry.effectiveAt) < now.getTime() + LEGAL_FEE_NOTICE_DAYS * DAY_MS;
}

/** The public page of a document on ebda.app (Arabic at the root, English under /en). */
export function legalPolicyUrl(key: LegalDocKey, lang: 'ar' | 'en'): string {
  return `https://${BRAND.domains.marketing}${lang === 'en' ? '/en' : ''}/${LEGAL_DOC_SLUG[key]}/`;
}

/** "7 October 2026" / "7 أكتوبر 2026": Latin digits (NUMERALS-1), read as a UTC calendar date. */
export function formatLegalDate(isoDate: string, lang: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export interface LegalDocRef {
  docKey: string;
  version: string;
}

export interface PendingLegalNotice {
  docKey: LegalDocKey;
  version: string;
  effectiveAt: string;
  summary: { ar: string; en: string };
  title: { ar: string; en: string };
  url: { ar: string; en: string };
}

/**
 * The ONE eligibility rule for a notice (banner AND "Got it"): a document's CURRENT version is
 * noticeable when it is material and has been sent (a `legal_notice_sends` row). Superseded,
 * non-material and unsent versions never are.
 */
export function isNoticeable(
  cur: LegalVersion,
  docKey: string,
  sent: readonly LegalDocRef[]
): boolean {
  return cur.material && sent.some(s => s.docKey === docKey && s.version === cur.version);
}

/** Every document's noticeable current version (see isNoticeable). */
export function noticeableVersions(
  policies: LegalPolicies,
  sent: readonly LegalDocRef[]
): Array<{ docKey: LegalDocKey; version: string }> {
  return LEGAL_DOC_KEYS.flatMap(docKey => {
    const cur = currentLegalVersion(policies, docKey);
    return isNoticeable(cur, docKey, sent) ? [{ docKey, version: cur.version }] : [];
  });
}

/**
 * The notices a merchant still has to see: each noticeable current version (isNoticeable) this
 * user has not accepted yet (a `legal_acceptances` row).
 */
export function computePendingNotices(
  policies: LegalPolicies,
  sent: readonly LegalDocRef[],
  accepted: readonly LegalDocRef[]
): PendingLegalNotice[] {
  const out: PendingLegalNotice[] = [];
  for (const { docKey: key, version } of noticeableVersions(policies, sent)) {
    if (accepted.some(r => r.docKey === key && r.version === version)) continue;
    const cur = currentLegalVersion(policies, key);
    out.push({
      docKey: key,
      version: cur.version,
      effectiveAt: cur.effectiveAt,
      summary: cur.summary,
      title: LEGAL_DOC_TITLE[key],
      url: { ar: legalPolicyUrl(key, 'ar'), en: legalPolicyUrl(key, 'en') },
    });
  }
  return out;
}
