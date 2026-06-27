import { describe, it, expect } from 'vitest';
import { resolveMyFatoorahEmail } from '../myfatoorah.provider';

/**
 * P0 regression (2026-06-10): a guest who skipped the OPTIONAL email field at
 * checkout sent MyFatoorah an empty CustomerEmail → "Invalid data" → the whole
 * payment failed. resolveMyFatoorahEmail must NEVER return an empty/invalid
 * address — it returns the real email when valid, else a valid placeholder on
 * the store domain.
 */
const VALID = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CB = 'https://wadyaljuz.com/checkout/success';

describe('resolveMyFatoorahEmail', () => {
  it('returns a VALID placeholder when email is empty (the P0 case)', () => {
    const out = resolveMyFatoorahEmail('', CB, 'ORD-123');
    expect(VALID.test(out)).toBe(true);
    expect(out).toBe('guest-ORD-123@wadyaljuz.com');
  });

  it('returns a valid placeholder when email is undefined', () => {
    expect(VALID.test(resolveMyFatoorahEmail(undefined, CB, 'ORD-1'))).toBe(true);
  });

  it('returns a valid placeholder when email is whitespace-only', () => {
    expect(VALID.test(resolveMyFatoorahEmail('   ', CB, 'ORD-2'))).toBe(true);
  });

  it('returns a valid placeholder when email is malformed', () => {
    const out = resolveMyFatoorahEmail('notanemail', CB, 'ORD-3');
    expect(VALID.test(out)).toBe(true);
    expect(out).not.toBe('notanemail');
  });

  it('passes through a real valid email unchanged', () => {
    expect(resolveMyFatoorahEmail('aziz@gmail.com', CB, 'ORD-4')).toBe('aziz@gmail.com');
  });

  it('uses the store domain from the callback URL host', () => {
    expect(resolveMyFatoorahEmail('', 'https://palora.com/x', 'ORD-5')).toBe(
      'guest-ORD-5@palora.com'
    );
  });

  it('falls back to the platform domain when the callback URL is unparseable', () => {
    const out = resolveMyFatoorahEmail('', 'not-a-url', 'ORD-6');
    expect(VALID.test(out)).toBe(true);
    expect(out).toBe('guest-ORD-6@force-ai.co');
  });

  it('never returns an empty string', () => {
    for (const e of ['', '   ', undefined, '@', 'a@b', 'x']) {
      expect(resolveMyFatoorahEmail(e as string | undefined, CB, 'ORD').length).toBeGreaterThan(0);
    }
  });
});
