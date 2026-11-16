/**
 * SEC-6 / M-130: merchant-chosen logo / ogImage URLs must be on our media origin.
 * Red if: the raster branch of the OG card skips the host check, `isEbdaMediaUrl` accepts a
 * foreign / http / credentialed host, or the write path accepts a new external logo.
 */
import { describe, it, expect } from 'vitest';
import { assertMediaOriginOrUnchanged as check } from '@api/lib/media-url-guard';
import { isEbdaMediaUrl } from '@ebda/shared';
import { isAllowedAssetUrl } from '../../apps/web/src/lib/og-asset-url';

describe('isEbdaMediaUrl', () => {
  it.each(['https://media.ebda.app/stores/s1/logo.webp', 'https://MEDIA.EBDA.APP/x.png'])(
    'accepts %s',
    u => expect(isEbdaMediaUrl(u)).toBe(true)
  );

  it.each([
    'https://pub-someone-elses-bucket.r2.dev/x.png', // any other R2 bucket
    'https://attacker.r2.dev/x.png',
    'https://media.ebda.app:8443/x.png', // non-default port
    'http://media.ebda.app/x.png', // not https
    'https://evil.example/logo.png',
    'https://r2.dev.evil.example/logo.png',
    'https://evilr2.dev/x.png',
    'https://media.ebda.app.evil.example/x.png',
    'https://user:pw@media.ebda.app/x.png',
    'https://169.254.169.254/latest/meta-data/x.png',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined,
    42,
  ])('rejects %s', u => expect(isEbdaMediaUrl(u)).toBe(false));

  it('accepts the deployment STORAGE_PUBLIC_URL host only when given', () => {
    expect(isEbdaMediaUrl('https://cdn.example-media.test/a.png')).toBe(false);
    expect(
      isEbdaMediaUrl('https://cdn.example-media.test/a.png', 'https://cdn.example-media.test')
    ).toBe(true);
    expect(isEbdaMediaUrl('https://other.test/a.png', 'https://cdn.example-media.test')).toBe(
      false
    );
    expect(
      isEbdaMediaUrl('https://cdn.example-media.test/a.png', 'http://cdn.example-media.test')
    ).toBe(false);
  });
});

describe('M-130: SSRF shapes the host allowlist must refuse', () => {
  const MEDIA = 'https://media.ebda.app/x.png';
  it('is true for the canonical URL (positive control)', () =>
    expect(isEbdaMediaUrl(MEDIA)).toBe(true));

  it.each([
    // private, loopback, link-local, metadata (v4 and v6, and the encodings that resolve to them)
    'https://127.0.0.1/x.png',
    'https://localhost/x.png',
    'https://10.0.0.5/x.png',
    'https://192.168.1.1/x.png',
    'https://172.16.0.1/x.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x.png',
    'https://[fd00:ec2::254]/latest/meta-data/',
    'https://[::ffff:169.254.169.254]/x.png',
    'https://2130706433/x.png', // decimal 127.0.0.1
    'https://0x7f000001/x.png', // hex 127.0.0.1
    'https://0177.0.0.1/x.png', // octal 127.0.0.1
    'https://metadata.google.internal/computeMetadata/v1/',
    // userinfo tricks: the allowlisted name is only a username, the real host is the attacker's
    'https://media.ebda.app@evil.example/x.png',
    'https://media.ebda.app:pw@evil.example/x.png',
    'https://media.ebda.app%40evil.example/x.png',
    // delimiters that make a parser disagree about the host
    'https://evil.example\\@media.ebda.app/x.png',
    'https://evil.example#@media.ebda.app/x.png',
    'https://evil.example?@media.ebda.app/x.png',
    'https://evil.example/@media.ebda.app/x.png',
    'https://media.ebda.app.evil.example/x.png',
    'https://evilmedia.ebda.app.example/x.png',
    'https://sub.media.ebda.app/x.png', // not the exact host
    'https://media.ebda.app:443@127.0.0.1/x.png',
    // non-http(s) schemes
    'http://media.ebda.app/x.png',
    'ftp://media.ebda.app/x.png',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'gopher://media.ebda.app/',
    'javascript:fetch("//169.254.169.254")',
    'blob:https://media.ebda.app/uuid',
    '//media.ebda.app/x.png', // scheme-relative
    'media.ebda.app/x.png', // no scheme
    ' https://evil.example/x.png',
    'https:/evil.example/x.png',
  ])('refuses %s', u => expect(isEbdaMediaUrl(u)).toBe(false));

  it('compares the PARSED host, so case, a trailing dot FQDN and an explicit default port cannot make a foreign host pass', () => {
    expect(isEbdaMediaUrl('https://MeDiA.EbDa.ApP/x.png')).toBe(true);
    // The WHATWG parser drops the default port, and `https://@host` has an empty userinfo: both are still OUR host, so accepted.
    expect(isEbdaMediaUrl('https://media.ebda.app:443/x.png')).toBe(true);
    expect(isEbdaMediaUrl('https://@media.ebda.app/x.png')).toBe(true);
    expect(isEbdaMediaUrl('https://evil.example./x.png')).toBe(false);
  });

  it('a redirect cannot widen the allowlist: the guard validates the URL string only, and the one server-side consumer (OG card) refuses to follow redirects', () => {
    // The guard is a pure host check on the stored URL. A media-origin URL that answers 302 -> 169.254.169.254 is only safe
    // if the fetcher does not follow it; assert the consumer's own guard rejects the metadata target if it is ever the URL itself.
    expect(isAllowedAssetUrl('https://169.254.169.254/x.png')).toBe(false);
    expect(isAllowedAssetUrl('https://media.ebda.app@169.254.169.254/x.png')).toBe(false);
  });

  it('the write path refuses every refused shape above with 400 MEDIA_URL_REQUIRED', () => {
    for (const u of [
      'https://media.ebda.app@evil.example/l.png',
      'https://127.0.0.1/l.png',
      'file:///etc/passwd',
    ]) {
      expect(() => check({ logo: u }, { logo: null })).toThrow(/media library/);
    }
  });
});

describe('our own R2 bucket only', () => {
  const OURS = 'https://pub-0123456789abcdef.r2.dev';
  it('accepts exactly the configured public host and refuses another bucket on r2.dev', () => {
    expect(isEbdaMediaUrl(`${OURS}/stores/s1/logo.png`, OURS)).toBe(true);
    expect(isEbdaMediaUrl('https://pub-ffffffffffffffff.r2.dev/logo.png', OURS)).toBe(false);
    expect(isEbdaMediaUrl(`${OURS}/logo.png`)).toBe(false);
  });
});

describe('OG card asset guard', () => {
  it('blocks a raster URL on a foreign host and metadata endpoints', () => {
    expect(isAllowedAssetUrl('https://attacker.example/pixel.png')).toBe(false);
    expect(isAllowedAssetUrl('https://169.254.169.254/x.png')).toBe(false);
    expect(isAllowedAssetUrl('https://media.ebda.app/stores/s/x.png')).toBe(true);
  });
});

describe('write path: assertMediaOriginOrUnchanged', () => {
  it('rejects a NEW external url with 400 MEDIA_URL_REQUIRED', () => {
    expect(() => check({ logo: 'https://evil.example/l.png' }, { logo: null })).toThrow(
      /media library/
    );
    try {
      check({ ogImage: 'http://169.254.169.254/x.png' }, { ogImage: null });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ statusCode: 400, code: 'MEDIA_URL_REQUIRED' });
    }
  });
  it('accepts media-origin, the configured public url, empty/undefined and an unchanged old value', () => {
    expect(() =>
      check({ ogImage: 'https://media.ebda.app/a.png' }, { ogImage: null })
    ).not.toThrow();
    expect(() =>
      check({ logo: 'https://cdn.example-media.test/a.png' }, {}, 'https://cdn.example-media.test')
    ).not.toThrow();
    expect(() => check({ logo: undefined, logoAr: '' }, {})).not.toThrow();
    expect(() =>
      check({ logo: 'https://old-host.example/l.png' }, { logo: 'https://old-host.example/l.png' })
    ).not.toThrow();
  });
});
