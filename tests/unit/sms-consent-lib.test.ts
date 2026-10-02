/**
 * Issue 206 — the phone key the promotional-SMS consent gate matches on, and
 * the signed opt-out token every promotional SMS carries.
 */
import { describe, it, expect } from 'vitest';
import {
  smsConsentPhoneKey,
  signSmsOptOutToken,
  verifySmsOptOutToken,
} from '../../apps/api/src/lib/sms-consent';

describe('smsConsentPhoneKey', () => {
  it('maps every way a Kuwait number is typed to one key', () => {
    for (const typed of [
      '+965 5123 4567',
      '96551234567',
      '0096551234567',
      '5123-4567',
      '51234567',
    ]) {
      expect(smsConsentPhoneKey(typed)).toBe('96551234567');
    }
  });

  it('keeps a foreign number as its digits', () => {
    expect(smsConsentPhoneKey('+44 7700 900123')).toBe('447700900123');
  });

  it('is null for anything that is not a phone (no consent can match it)', () => {
    for (const bad of [null, undefined, '', '   ', '123', 'abc', '1'.repeat(16)]) {
      expect(smsConsentPhoneKey(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('SMS opt-out token', () => {
  const id = '3f2b8a52-6c0d-4b8e-9d7a-1e2f3a4b5c6d';

  it('round-trips and stays short enough for an SMS', () => {
    const token = signSmsOptOutToken(id);
    expect(token.length).toBeLessThanOrEqual(60);
    expect(verifySmsOptOutToken(token)).toBe(id);
  });

  it('rejects a tampered MAC, a swapped id, and malformed input', () => {
    const token = signSmsOptOutToken(id);
    const [, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifySmsOptOutToken(`${id}.${flipped}`)).toBeNull();
    const other = '3f2b8a52-6c0d-4b8e-9d7a-1e2f3a4b5c6e';
    expect(verifySmsOptOutToken(`${other}.${sig}`)).toBeNull();
    for (const bad of [undefined, 42, '', id, `${id}.`, `${id}.${sig}.x`, 'x'.repeat(200)]) {
      expect(verifySmsOptOutToken(bad)).toBeNull();
    }
  });
});
