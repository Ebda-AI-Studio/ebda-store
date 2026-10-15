/**
 * scrubEmails hardening (commit security scan on the legal-notice failed-deliveries list): an
 * address in provider error text must not survive in ANY form a mail provider or a renderer
 * would still read, and the scan must stay bounded on huge input.
 */
import { describe, it, expect } from 'vitest';
import { SCRUB_EMAILS_MAX, scrubEmails } from '@api/lib/pii-mask';

const leaks = (out: string, ...secrets: string[]) =>
  secrets.filter(s => out.toLowerCase().includes(s.toLowerCase()));

describe('scrubEmails', () => {
  it('plain, with surrounding punctuation, keeps the domain and the punctuation', () => {
    expect(scrubEmails('mailbox full for jane.doe@gmail.com (550)')).toBe(
      'mailbox full for j***@gmail.com (550)'
    );
    expect(scrubEmails('to <jane.doe@gmail.com>, cc (bob@x.io)')).toBe(
      'to <j***@gmail.com>, cc (b***@x.io)'
    );
  });

  it.each([
    ['unicode / IDN', 'رفض: مُنى.علي@مثال.مصر لأن', 'مُنى.علي'],
    ['IDN punycode', 'user.name@xn--mgbh0fb.xn--wgbh1c failed', 'user.name'],
    ['quoted local part with a space', 'bad "john doe"@example.com here', 'john doe'],
    ['URL-encoded @', 'GET /v?to=jane.doe%40gmail.com 422', 'jane.doe'],
    ['HTML entity &#64;', 'recipient jane.doe&#64;gmail.com', 'jane.doe'],
    ['HTML hex entity &#x40;', 'recipient jane.doe&#x40;gmail.com', 'jane.doe'],
    ['named entity &commat;', 'recipient jane.doe&commat;gmail.com', 'jane.doe'],
    ['mailto:', 'see mailto:jane.doe@gmail.com', 'jane.doe'],
    ['plus addressing, uppercase', 'JANE.DOE+legal@Gmail.COM bounced', 'JANE.DOE+legal'],
  ])('masks %s', (_label, input, secret) => {
    const out = scrubEmails(input);
    expect(leaks(out, secret)).toEqual([]);
    expect(out).toContain('***');
  });

  it('the known recipient is redacted exactly and case-insensitively even when not email-shaped there', () => {
    const out = scrubEmails('Rejected: JANE.Doe@Gmail.com / user jane.doe@gmail.com', [
      'jane.doe@gmail.com',
    ]);
    expect(leaks(out, 'jane.doe@gmail.com', 'jane.doe')).toEqual([]);
  });

  it('cuts the input BEFORE matching, and a huge adversarial input stays fast', () => {
    const tail = 'secret.person@example.com';
    const huge = `${'a'.repeat(SCRUB_EMAILS_MAX)}${tail}`;
    expect(scrubEmails(huge)).not.toContain('secret.person');
    expect(scrubEmails(huge).length).toBeLessThanOrEqual(SCRUB_EMAILS_MAX);
    const nasty = `${'a.'.repeat(500_000)}@`; // 1 MB, no whitespace, classic backtracking bait
    const t0 = performance.now();
    scrubEmails(nasty);
    scrubEmails('%40'.repeat(300_000));
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('text without an address is unchanged', () => {
    expect(scrubEmails('Resend send failed: rate limited (429)')).toBe(
      'Resend send failed: rate limited (429)'
    );
  });
});
