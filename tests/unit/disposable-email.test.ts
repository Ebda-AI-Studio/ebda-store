/**
 * SP5 task 4 - disposable / throwaway email domain blocklist.
 *
 * Mutation proof (recorded in the commit body): in
 * packages/shared/src/abuse/disposable-email-domains.ts drop the parent-domain
 * walk in `isDisposableEmail` (check only the full domain) -> "blocks
 * subdomains" fails.
 */
import { describe, it, expect } from 'vitest';
import { DISPOSABLE_EMAIL_DOMAINS, emailDomain, isDisposableEmail } from '@force/shared';

describe('disposable email blocklist', () => {
  it('ships a few hundred domains, all lowercase bare domains', () => {
    expect(DISPOSABLE_EMAIL_DOMAINS.length).toBeGreaterThanOrEqual(300);
    for (const d of DISPOSABLE_EMAIL_DOMAINS) {
      expect(d).toBe(d.toLowerCase());
      expect(d).not.toMatch(/[@\s*]/);
    }
  });

  it('never lists a mainstream provider', () => {
    for (const ok of ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com']) {
      expect(DISPOSABLE_EMAIL_DOMAINS).not.toContain(ok);
      expect(isDisposableEmail(`a@${ok}`)).toBe(false);
    }
  });

  it('blocks listed domains case-insensitively', () => {
    expect(isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(isDisposableEmail('A@MAILINATOR.COM')).toBe(true);
    expect(isDisposableEmail('a@Yopmail.Com')).toBe(true);
  });

  it('blocks subdomains of a listed domain', () => {
    expect(isDisposableEmail('a@x.mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@deep.sub.guerrillamail.com')).toBe(true);
  });

  it('does not match look-alike siblings that merely end with a listed name', () => {
    expect(isDisposableEmail('a@evilmailinator.com')).toBe(false);
    expect(isDisposableEmail('a@mailinator.com.example.org')).toBe(false);
  });

  it('is false for malformed input', () => {
    expect(isDisposableEmail('nope')).toBe(false);
    expect(isDisposableEmail('a@')).toBe(false);
    expect(isDisposableEmail(null)).toBe(false);
    expect(emailDomain('A@Sub.Example.COM.')).toBe('sub.example.com');
  });
});
