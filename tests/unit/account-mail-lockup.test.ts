/**
 * BRAND-ARCH-1: ACCOUNT / identity mail (from "Ebda AI Studio") carries the Ebda AI Studio lockup in its
 * header; STORE mail carries the Ebda Store lockup. The header text is the `store-name` block of the shell.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BRAND } from '@ebda/shared';
import {
  clearCapturedMail,
  latestCapturedMailTo,
  sendMerchantPasswordResetEmail,
  sendMerchantVerificationEmail,
  sendStaffInviteEmail,
  sendPasskeyNoticeEmail,
} from '@api/services/platform-mailer';

const header = (html: string) => /class="store-name"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';

beforeEach(() => clearCapturedMail());

describe('account mail header lockup', () => {
  it.each([
    ['en', BRAND.name],
    ['ar', BRAND.nameAr],
  ] as const)(
    'password reset (%s) shows the studio, not the store product',
    async (lang, expected) => {
      await sendMerchantPasswordResetEmail(
        {
          email: 'a@test.local',
          name: 'A',
          resetUrl: 'https://x.test/r?token=t',
          expiresInMinutes: 30,
        },
        lang
      );
      const h = header(latestCapturedMailTo('a@test.local')!.html);
      expect(h).toBe(expected);
      expect(h).not.toBe(BRAND.product.nameEn);
      expect(h).not.toBe(BRAND.product.nameAr);
    }
  );

  it('verification, staff invite and passkey notice use the studio lockup too', async () => {
    await sendMerchantVerificationEmail(
      {
        email: 'v@test.local',
        name: 'V',
        verificationUrl: 'https://x.test/v?token=t',
        expiresInHours: 24,
      },
      'ar'
    );
    expect(header(latestCapturedMailTo('v@test.local')!.html)).toBe(BRAND.nameAr);
    await sendStaffInviteEmail(
      {
        email: 's@test.local',
        storeName: 'Souq',
        inviterName: 'I',
        setPasswordUrl: null,
        loginUrl: 'https://x.test',
      } as never,
      'en'
    );
    expect(header(latestCapturedMailTo('s@test.local')!.html)).toBe(BRAND.name);
    await sendPasskeyNoticeEmail(
      {
        email: 'p@test.local',
        name: 'P',
        kind: 'added',
        passkeyName: 'iPhone',
        at: new Date().toISOString(),
      },
      'en'
    );
    expect(header(latestCapturedMailTo('p@test.local')!.html)).toBe(BRAND.name);
  });
});
