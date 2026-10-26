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
