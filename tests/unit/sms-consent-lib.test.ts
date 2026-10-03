/**
 * Issue 206 — the phone key the promotional-SMS consent gate matches on, and
 * the signed opt-out token every promotional SMS carries.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// A mutable config so a test can rotate one secret and keep the other.
const cfg = vi.hoisted(() => ({
  jwtSecret: 'session-secret-A-0123456789abcdef0123',
  encryptionKey: 'encryption-key-A-0123456789abcdef012',
}));
vi.mock('../../apps/api/src/config', () => ({ config: cfg }));

import {
  smsConsentPhoneKey,
  signSmsOptOutToken,
  verifySmsOptOutToken,
  SMS_OPT_OUT_TOKEN_LENGTH,
} from '../../apps/api/src/lib/sms-consent';

const ORIGINAL = { ...cfg };
const ORIGINAL_ENV_JWT = process.env.JWT_SECRET;
afterEach(() => {
  Object.assign(cfg, ORIGINAL);
  process.env.JWT_SECRET = ORIGINAL_ENV_JWT;
});

describe('smsConsentPhoneKey', () => {
  it('maps every way an Egyptian mobile is typed to one key', () => {
    for (const typed of [
      '+20 10 1234 5678',
      '+201012345678',
      '201012345678',
      '00201012345678',
      '010 1234 5678',
      '01012345678',
      '1012345678',
      '٠١٠١٢٣٤٥٦٧٨', // Eastern Arabic digits
    ]) {
      expect(smsConsentPhoneKey(typed)).toBe('201012345678');
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

  it('round-trips at a fixed 45 characters (the SMS length budget relies on it)', () => {
    const token = signSmsOptOutToken(id);
    expect(SMS_OPT_OUT_TOKEN_LENGTH).toBe(45);
    expect(token).toHaveLength(SMS_OPT_OUT_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(token).not.toContain(id); // the id travels as bytes, not as the 36-char uuid
    expect(verifySmsOptOutToken(token)).toBe(id);
    expect(verifySmsOptOutToken(signSmsOptOutToken(id.toUpperCase()))).toBe(id);
  });

  it('rejects a tampered MAC, a swapped id, and malformed input', () => {
    const token = signSmsOptOutToken(id);
    const [idPart, sig] = token.split('.');
    // Flip a FULL 6-bit character in the middle, not the last one (whose low
    // bits are padding and may decode to the same bytes).
    const flip = (x: string) => x.slice(0, 5) + (x[5] === 'A' ? 'B' : 'A') + x.slice(6);
    expect(verifySmsOptOutToken(`${idPart}.${flip(sig)}`)).toBeNull();
    expect(verifySmsOptOutToken(`${flip(idPart)}.${sig}`)).toBeNull();
    const other = signSmsOptOutToken('3f2b8a52-6c0d-4b8e-9d7a-1e2f3a4b5c6e').split('.')[0];
    expect(verifySmsOptOutToken(`${other}.${sig}`)).toBeNull();
    for (const bad of [
      undefined,
      42,
      '',
      id,
      `${idPart}.`,
      `${idPart}${sig}`,
      `${idPart}.${sig}.x`,
      `${id}.${sig}`, // the v1 shape
      'x'.repeat(200),
    ]) {
      expect(verifySmsOptOutToken(bad)).toBeNull();
    }
  });

  it('accepts only the canonical spelling of each half', () => {
    const token = signSmsOptOutToken(id);
    const [idPart, sig] = token.split('.');
    // 16 bytes = 21 full base64 chars + 2 bits; the last char's low 4 bits are
    // padding. Setting them yields a different string that decodes to the
    // same bytes, which must NOT verify.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respell = (x: string) => {
      const v = alphabet.indexOf(x[21]);
      return x.slice(0, 21) + alphabet[(v & 0b110000) | 0b0001];
    };
    expect(Buffer.from(respell(sig), 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    expect(verifySmsOptOutToken(`${idPart}.${respell(sig)}`)).toBeNull();
    expect(verifySmsOptOutToken(`${respell(idPart)}.${sig}`)).toBeNull();
  });

  it('survives a JWT_SECRET (session secret) rotation — issue 2424', () => {
    const token = signSmsOptOutToken(id);
    cfg.jwtSecret = 'session-secret-B-rotated-0123456789abcd';
    process.env.JWT_SECRET = 'session-secret-B-rotated-0123456789abcd';
    expect(verifySmsOptOutToken(token)).toBe(id);
  });

  it('is keyed on ENCRYPTION_KEY: another key cannot forge or verify it', () => {
    const token = signSmsOptOutToken(id);
    cfg.encryptionKey = 'encryption-key-B-0123456789abcdef012';
    expect(verifySmsOptOutToken(token)).toBeNull();
  });

  it('fails loud, instead of signing with an empty key, when ENCRYPTION_KEY is unset', () => {
    cfg.encryptionKey = '';
    expect(() => signSmsOptOutToken(id)).toThrow(/ENCRYPTION_KEY/);
  });
});
