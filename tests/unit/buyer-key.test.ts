/**
 * Suite buyer key (contract section 6). The pinned vector is identical in the Ebda Chat repo:
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

  it('PHONE-2: a 0-prefixed number is Egyptian ONLY if it is a valid Egyptian number', () => {
    // not Egyptian shapes -> null, never read as +20
    expect(toE164('07911123456')).toBeNull(); // UK mobile
    expect(toE164('0100123456')).toBeNull(); // mobile one digit short
    expect(toE164('0312345678')).toBeNull(); // Alexandria is 03 + 7, this is 03 + 8
    expect(toE164('0912345678')).toBeNull(); // no such area code
    expect(toE164('2012345678901')).toBeNull();
    // the `20...` and bare `1...` branches obey the same rule
    expect(toE164('201912345678')).toBeNull(); // 20 + a number that is not Egyptian
    expect(toE164('201001234567')).toBe('+201001234567');
    expect(toE164('2021234567')).toBeNull(); // 10 digits starting 20: not a 12-digit 20... form
    expect(toE164('1912345678')).toBeNull(); // bare 10 digits starting 1 but not a 1[0125] mobile
    expect(toE164('1001234567')).toBe('+201001234567');
    // valid Egyptian shapes -> +20
    expect(toE164('01001234567')).toBe('+201001234567'); // mobile
    expect(toE164('0212345678')).toBe('+20212345678'); // Cairo/Giza 02 + 8
    expect(toE164('0312345')).toBeNull();
    expect(toE164('03 123 4567')).toBe('+2031234567'); // Alexandria 03 + 7
    expect(toE164('040 123 4567')).toBe('+20401234567'); // governorate code + 7
    // a foreign number must carry + or 00
    expect(toE164('+44 7911 123456')).toBe('+447911123456');
  });

  it('does not strip arbitrary text the way the old Store normaliser did', () => {
    expect(toE164('tel:+201001234567')).toBeNull();
    expect(toE164('+20 100 123 4567 x12')).toBeNull();
  });

  it('drops the bidi marks WhatsApp adds around a number', () => {
    expect(toE164('\u200E+20 100 123 4567\u200F')).toBe('+201001234567');
    expect(toE164('\u202A01001234567\u202C')).toBe('+201001234567');
  });

  it('keeps another country code as given', () => {
    expect(toE164('+966 50 123 4567')).toBe('+966501234567');
    expect(toE164('00966501234567')).toBe('+966501234567');
  });

  it.each([null, undefined, '', '   ', 'abc', '123', '+0123456789', '+2010012345678901'])(
    '%j is not a phone',
    raw => {
      expect(toE164(raw as string | null | undefined)).toBeNull();
    }
  );
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
