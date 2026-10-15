import { BRAND } from '@ebda/shared';
import { escapeHtml } from './_util';

/**
 * Material policy-change notice (Ruling LEGAL-4). A service/legal notice to every store
 * owner, NOT marketing: it carries no unsubscribe link, by design (documented in the ruling
 * and in the email's own footer line).
 *
 * One bilingual email for every recipient (Ruling LEGAL-6): the full Arabic block first
 * (`dir="rtl"`), then the full English block (`dir="ltr"`). `users.language` is not read:
 * legacy accounts carry the column default 'en', so the stored value is unreliable for a
 * legal notice.
 */
type Bilingual = { ar: string; en: string };

export interface LegalNoticeEmailData {
  name: string;
  /** Document title (LEGAL_DOC_TITLE). */
  title: Bilingual;
  /** What changed (the registry entry's summary). */
  summary: Bilingual;
  /** Effective date, already formatted with Latin digits (formatLegalDate). */
  effectiveOn: Bilingual;
  /** The policy page on ebda.app (legalPolicyUrl). */
  url: Bilingual;
}

const arBlock = (d: LegalNoticeEmailData) => `
  <div dir="rtl" lang="ar" style="text-align:right;">
    <h2>حدّثنا ${escapeHtml(d.title.ar)}</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>${escapeHtml(d.summary.ar)}</p>
    <p>النسخة الجديدة تسري من <strong>${escapeHtml(d.effectiveOn.ar)}</strong>. استمرارك في استخدام ${escapeHtml(BRAND.product.nameAr)} بعد التاريخ ده يعني موافقتك عليها؛ ولو مش موافق تقدر تقفل حسابك قبلها.</p>
    <p style="text-align:center;margin:24px 0;"><a href="${escapeHtml(d.url.ar)}" class="button">اقرأ ${escapeHtml(d.title.ar)}</a></p>
    <p style="font-size:14px;color:#666;">دي رسالة خدمة بخصوص حسابك. بنبعتها لكل التجار لما سياسة تتغير تغيير جوهري، علشان كده مافيهاش رابط لإيقاف الرسائل. عندك سؤال؟ رد على الرسالة دي.</p>
  </div>`;

const enBlock = (d: LegalNoticeEmailData) => `
  <div dir="ltr" lang="en" style="text-align:left;">
    <h2>We updated our ${escapeHtml(d.title.en)}</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>${escapeHtml(d.summary.en)}</p>
    <p>The new version takes effect on <strong>${escapeHtml(d.effectiveOn.en)}</strong>. Continuing to use ${escapeHtml(BRAND.product.nameEn)} after that date means you accept it; if you do not, you can close your account before then.</p>
    <p style="text-align:center;margin:24px 0;"><a href="${escapeHtml(d.url.en)}" class="button">Read the ${escapeHtml(d.title.en)}</a></p>
    <p style="font-size:14px;color:#666;">This is a service notice about your account. We send it to every merchant when a policy changes in a material way, so it has no opt-out link. Questions? Reply to this email.</p>
  </div>`;

export const legalNoticeTemplate = {
  /** Bilingual, Arabic first; product names from BRAND, never typed. */
  subject: () => `تحديث في سياسات ${BRAND.product.nameAr} · ${BRAND.product.nameEn} policy update`,
  /** Arabic block, a rule, then the English block. */
  body: (d: LegalNoticeEmailData) =>
    `${arBlock(d)}\n  <hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;" />\n${enBlock(d)}`,
};
