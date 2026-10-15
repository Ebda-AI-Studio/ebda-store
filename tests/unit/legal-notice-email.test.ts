/**
 * The legal-notice email (Rulings LEGAL-4, LEGAL-6): ONE bilingual mail, the full Arabic block
 * first then the full English block, Latin digits, links, no unsubscribe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BRAND } from '@ebda/shared';
import {
  sendLegalNoticeEmail,
  clearCapturedMail,
  latestCapturedMailTo,
} from '@api/services/platform-mailer';

const data = {
  email: 'm@test.local',
  name: 'Mona <b>',
  title: { ar: 'شروط الخدمة', en: 'Terms of service' },
  summary: { ar: 'تغيير في الرسوم.', en: 'Fee change.' },
  effectiveOn: { ar: '20 نوفمبر 2026', en: '20 November 2026' },
  url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
};

beforeEach(() => clearCapturedMail());

describe('sendLegalNoticeEmail', () => {
  it('one mail carries both languages, Arabic block first', async () => {
    await sendLegalNoticeEmail(data);
    const mail = latestCapturedMailTo('m@test.local')!;
    const ar = mail.html.indexOf('dir="rtl" lang="ar"');
    const en = mail.html.indexOf('dir="ltr" lang="en"');
    expect(ar).toBeGreaterThan(-1);
    expect(en).toBeGreaterThan(ar);
    const arPart = mail.html.slice(ar, en);
    const enPart = mail.html.slice(en);
    for (const s of [
      'شروط الخدمة',
      'تغيير في الرسوم.',
      '20 نوفمبر 2026',
      'https://ebda.app/terms/',
    ]) {
      expect(arPart).toContain(s);
    }
    for (const s of [
      'Terms of service',
      'Fee change.',
      '20 November 2026',
      'https://ebda.app/en/terms/',
    ]) {
      expect(enPart).toContain(s);
    }
    // The first link a reader (and the outbox) meets is the Arabic policy page.
    expect(mail.link).toBe('https://ebda.app/terms/');
  });

  it('subject is bilingual (Arabic first) and built from BRAND', async () => {
    await sendLegalNoticeEmail(data);
    const mail = latestCapturedMailTo('m@test.local')!;
    expect(mail.subject).toBe(
      `تحديث في سياسات ${BRAND.product.nameAr} · ${BRAND.product.nameEn} policy update`
    );
    expect(mail.subject.indexOf(BRAND.product.nameAr)).toBeLessThan(
      mail.subject.indexOf(BRAND.product.nameEn)
    );
  });

  it('Latin digits, escaped name, reply-to support, no unsubscribe link', async () => {
    await sendLegalNoticeEmail(data);
    const mail = latestCapturedMailTo('m@test.local')!;
    expect(mail.html).not.toMatch(/[٠-٩]/);
    expect(mail.html).not.toMatch(/unsubscribe|إلغاء الاشتراك/i);
    expect(mail.html).toContain('Mona &lt;b&gt;');
    expect(mail.html).not.toContain('Mona <b>');
    expect(mail.replyTo).toBe(BRAND.supportEmail);
  });
});
