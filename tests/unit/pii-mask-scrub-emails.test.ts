/**
 * scrubEmails hardening (commit security scan on the legal-notice failed-deliveries list): an
 * address in provider error text must not survive in ANY form a mail provider or a renderer
 * would still read, and the scan must stay bounded on huge input.
 */
import { describe, it, expect } from 'vitest';
import {
  SCRUB_EMAILS_MAX,
  maskEmail,
  maskEmailList,
  maskPhone,
  scrubEmails,
} from '@api/lib/pii-mask';

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

  // Residual forms from the final re-review: the "@" is spelled in a way the detector missed.
  it.each([
    ['fullwidth ＠ (U+FF20)', 'to jane.doe\uFF20gmail.com failed', 'jane.doe'],
    ['small ﹫ (U+FE6B)', 'to jane.doe\uFE6Bgmail.com failed', 'jane.doe'],
    ['double-encoded %2540', 'GET ?to=jane.doe%2540gmail.com', 'jane.doe'],
    ['triple-encoded %252540', 'GET ?to=jane.doe%252540gmail.com', 'jane.doe'],
    ['&#64 without the semicolon', 'recipient jane.doe&#64gmail.com', 'jane.doe'],
    ['&#x40 without the semicolon', 'recipient jane.doe&#x40gmail.com', 'jane.doe'],
    ['&amp;#64; (entity of an entity)', 'recipient jane.doe&amp;#64;gmail.com', 'jane.doe'],
    ['quoted-printable =40', 'body jane.doe=40gmail.com end', 'jane.doe'],
    ['RFC 2047 encoded word', 'From: =?utf-8?Q?jane.doe=40gmail.com?=', 'jane.doe'],
    ['JSON-escaped \\u0040', 'raw jane.doe\\u0040gmail.com', 'jane.doe'],
    ['escaped \\x40', 'raw jane.doe\\x40gmail.com', 'jane.doe'],
    ['space before @', 'to jane.doe @gmail.com bounced', 'jane.doe'],
    ['spaces around @', 'to jane.doe @ gmail.com bounced', 'jane.doe'],
    ['spaces around a fullwidth ＠', 'to jane.doe \uFF20 gmail.com bounced', 'jane.doe'],
    ['quoted local with escaped quotes', 'bad "john \\"q\\" doe"@example.com here', 'john'],
    [
      'quoted local part over 64 characters',
      `bad "${'secret word '.repeat(8)}"@example.com here`,
      'secret word',
    ],
  ])('masks %s', (_label, input, secret) => {
    const out = scrubEmails(input);
    expect(leaks(out, secret)).toEqual([]);
    expect(out).toContain('***');
  });

  it('keeps the masked shape for a spaced address and leaves ordinary "=40" text alone', () => {
    expect(scrubEmails('to jane.doe @ gmail.com bounced')).toBe('to j***@gmail.com bounced');
    expect(scrubEmails('limit=40 rows, price=40.5, id=400')).toBe(
      'limit=40 rows, price=40.5, id=400'
    );
  });

  it('a quoted local part is replaced WHOLE, with its domain, by ***', () => {
    expect(scrubEmails('bad "john \\"q\\" doe"@example.com here')).toBe('bad *** here');
  });

  it('Turkish İ: matching the known recipient does not drift indices or drop trailing text', () => {
    const out = scrubEmails('İİİİİİ JANE.DOE@GMAIL.COM x', ['jane.doe@gmail.com']);
    expect(out).toBe('İİİİİİ j***@gmail.com x');
    expect(scrubEmails('İstanbul İİ x@y.zz tail', ['x@y.zz'])).toBe('İstanbul İİ x***@y.zz tail');
    expect(scrubEmails('İİİİİİ user@mail.com tail')).toBe('İİİİİİ u***@mail.com tail');
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
    scrubEmails('"'.repeat(300_000));
    scrubEmails(`"${'\\"'.repeat(300_000)}@`);
    scrubEmails(` ${'@ '.repeat(300_000)}`);
    scrubEmails('%25'.repeat(300_000));
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('text without an address is unchanged', () => {
    expect(scrubEmails('Resend send failed: rate limited (429)')).toBe(
      'Resend send failed: rate limited (429)'
    );
  });
});

/**
 * Characterization: the pre-existing exports keep their origin/main outputs exactly (a security
 * scan flagged pii-mask.ts as a possible regression; these pin the behaviour every existing
 * caller across apps/api relies on). Values measured from origin/main's pii-mask.ts.
 */
describe('pre-existing masks are unchanged (characterization vs origin/main)', () => {
  it.each([
    ['jane.doe@gmail.com', 'j***@gmail.com'],
    ['JANE.DOE@GMAIL.COM', 'J***@GMAIL.COM'],
    ['jane+tag@gmail.com', 'j***@gmail.com'],
    ['مُنى@مثال.مصر', 'م***@مثال.مصر'],
    ['user@xn--mgbh0fb.xn--wgbh1c', 'u***@xn--mgbh0fb.xn--wgbh1c'],
    ['no-at-sign', '***'],
    ['a@b@c.com', 'a***@c.com'],
    ['@leading.com', '***'],
    ['trailing@', 't***@'],
    ['', null],
    [' ', null],
    [null, null],
    [undefined, null],
  ])('maskEmail(%j) -> %j', (input, out) => {
    expect(maskEmail(input as string | null | undefined)).toBe(out);
  });

  it('maskPhone and maskEmailList keep their outputs', () => {
    expect(maskPhone('+201012345678')).toBe('+201 ****5678');
    expect(maskPhone('0101 2345 678')).toBe('****5678');
    expect(maskPhone('123')).toBe('****');
    expect(maskPhone('')).toBeNull();
    expect(maskEmailList(['a@b.com', 'C@D.COM'])).toEqual(['a***@b.com', 'C***@D.COM']);
    expect(maskEmailList('x@y.z')).toBe('x***@y.z');
  });

  it('scrubEmails never masks LESS than the Task 8 version: lists, markup, multiple @', () => {
    expect(scrubEmails('a@x.com,b@y.com')).toBe('a***@x.com,b***@y.com');
    expect(scrubEmails('a@x.com;b@y.com')).toBe('a***@x.com;b***@y.com');
    expect(scrubEmails('[jane@gmail.com]')).toBe('[j***@gmail.com]');
    // ambiguous shapes now fail CLOSED (whole token), never a partial split
    expect(scrubEmails('x<jane@gmail.com>')).toBe('***');
    expect(scrubEmails('a@b@c.com')).toBe('***');
  });
});

/**
 * Fail closed (third security scan: parser differential / local-part split). For every shape a
 * mail parser could split differently, no character of the local part survives beyond the one
 * allowed first character.
 */
describe('scrubEmails fails closed on ambiguous address shapes', () => {
  const survivors = (out: string, local: string) =>
    Array.from(local.slice(1)).filter(c => /[\p{L}\p{N}]/u.test(c) && out.includes(c));

  it.each([
    ['quoted local part holding an @', '"alice@inner"@evil.com', 'alice@inner'],
    ['quoted local part holding a space', 'x "alice smith"@evil.com y', 'alice smith'],
    ['two @ in one token', 'alice@bobby@c.com', 'alice@bobby'],
    ['comment in the local part', 'alice(note)@b.com', 'alice(note)'],
    ['comment after the local part', 'alice@(c)b.com', 'alice'],
    ['angle brackets glued to text', 'Name<alice@b.com>', 'Namealice'],
    ['a dotless domain', 'alice@localhost', 'alice'],
    ['encoded @ twice', 'alice%40bobby%40c.com', 'alicebobby'],
    ['backslash-escaped local part', 'ali\\@ce@b.com', 'alice'],
  ])('%s', (_label, input, local) => {
    const out = scrubEmails(`fail: ${input} (550)`);
    expect(survivors(out.replace('fail: ', '').replace(' (550)', ''), local)).toEqual([]);
  });

  it('keeps the clean, readable forms (display name, trailing dot, mailto)', () => {
    expect(scrubEmails('Name <alice@b.com>')).toBe('Name <a***@b.com>');
    expect(scrubEmails('to alice@b.com.')).toBe('to a***@b.com.');
    expect(scrubEmails('mailto:alice@b.com')).toBe('mailto:a***@b.com');
    expect(scrubEmails('"Alice" <alice@b.com>')).toBe('"Alice" <a***@b.com>');
  });
});
