/**
 * Suite buyer key (contract section 6). The pinned vector is identical in the Ebda WhatsApp repo:
 * if either side's normaliser or hash drifts, this fails first.
 */
import { describe, it, expect } from 'vitest';
import { BUYER_KEY_VERSION, buyerKeyFor, toE164 } from '@ebda/shared';

const SECRET = 'ebda-suite-buyer-key-test-v1';
const VECTOR = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';

describe('toE164 (Egypt default +20)', () => {
  it.each([
    '01001234567',
    '201001234567',
    '+201001234567',
    '+20 100 123 4567',
    '+20 0100 123 4567', // trunk 0 after the country code
    '00201001234567',
    '(0100) 123-4567',
    '٠١٠٠١٢٣٤٥٦٧', // Arabic-Indic digits
    '۰۱۰۰۱۲۳۴۵۶۷', // extended (Persian) digits
    '1001234567',
  ])('%s -> +201001234567', raw => {
    expect(toE164(raw)).toBe('+201001234567');
  });

  it('a foreign number needs + or 00: national-looking foreign numbers are NOT turned into Egyptian ones', () => {
    expect(toE164('07911123456')).toBeNull(); // UK mobile
    expect(toE164('0501234567')).toBeNull(); // Saudi national
    expect(toE164('0212345678')).toBeNull(); // Cairo landline
    expect(toE164('2012345678901')).toBeNull();
  });

  it('keeps another country code as given', () => {
    expect(toE164('+966 50 123 4567')).toBe('+966501234567');
    expect(toE164('00966501234567')).toBe('+966501234567');
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'abc',
    '123',
    '+0123456789',
    '0100123456',
    '+2010012345678901',
  ])('%j is not a phone', raw => {
    expect(toE164(raw as string | null | undefined)).toBeNull();
  });
});

describe('buyerKeyFor', () => {
  it('matches the contract vector for every spelling of the same phone', async () => {
    for (const raw of [
      '+201001234567',
      '01001234567',
      '201001234567',
      '+20 100 123 4567',
      '٠١٠٠١٢٣٤٥٦٧',
    ]) {
      expect(await buyerKeyFor(SECRET, raw)).toBe(VECTOR);
    }
  });
  it('is lowercase hex of 64 chars, depends on the secret, and is null without a phone', async () => {
    const k = await buyerKeyFor(SECRET, '01001234567');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(await buyerKeyFor('another-secret', '01001234567')).not.toBe(k);
    expect(await buyerKeyFor(SECRET, 'not a phone')).toBeNull();
    expect(await buyerKeyFor(SECRET, null)).toBeNull();
  });
  it('refuses to hash without a secret (never an unkeyed hash)', async () => {
    await expect(buyerKeyFor('', '01001234567')).rejects.toThrow(/SUITE_BUYER_KEY_SECRET/);
  });
  it('carries a key version for CI envelopes', () => {
    expect(BUYER_KEY_VERSION).toBe(1);
  });
});
