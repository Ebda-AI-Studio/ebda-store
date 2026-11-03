import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../apps/orders/src/i18n/messages';
import { signInErrorText, signInMessageKey } from '../../apps/orders/src/lib/sign-in-error';

describe('orders sign-in shows our sentence, never the service text (audit A-1)', () => {
  for (const locale of ['en', 'ar'] as const) {
    const texts = MESSAGES[locale].login;
    it(`${locale}: a coded refusal maps to its sentence`, () => {
      expect(signInErrorText(signInMessageKey(401, 'INVALID_CREDENTIALS'), texts)).toBe(
        texts.invalidCredentials
      );
      expect(signInErrorText(signInMessageKey(429, 'ACCOUNT_LOCKED'), texts)).toBe(texts.tooManyAttempts);
      expect(signInErrorText('ADMIN_ONLY', texts)).toBe(texts.adminOnly);
    });
    it(`${locale}: a raw message becomes the generic failure`, () => {
      expect(signInErrorText('Invalid email or password', texts)).toBe(texts.failed);
      expect(signInErrorText('Failed to fetch', texts)).toBe(texts.failed);
    });
  }
  it('the Arabic orders sign-in sentences are Egyptian, not Modern Standard', () => {
    const ar = Object.values(MESSAGES.ar.login).join(' ');
    expect(ar).not.toMatch(/فشل|تعذّر|يرجى|الرجاء|لا يمكن/);
  });
});
