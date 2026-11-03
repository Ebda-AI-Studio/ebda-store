/**
 * Ruling SIGNIN-RETURN-1: after sign-in the admin returns to `?return=` only when it is https on an explicit host
 * allowlist; everything else falls back to the normal destination. This is an open-redirect boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  RETURN_HOSTS,
  safeSignInReturn,
  signInProduct,
} from '../../apps/admin/src/lib/sign-in-return';

describe('safeSignInReturn: accepted', () => {
  it.each([
    'https://wa.ebda.app/inbox',
    'https://wa.ebda.app/',
    'https://wa.ebda.app',
    'https://store.ebda.app/stores/abc/orders?x=1#top',
    'https://orders.ebda.app/orders',
    'https://ebda.app/whatsapp',
    'https://WA.EBDA.APP/inbox', // host is case-insensitive
    'https://wa.ebda.app:443/inbox', // the default https port is no "other port"
  ])('%s', url => {
    const out = safeSignInReturn(url);
    expect(out).not.toBeNull();
    expect(new URL(out!).protocol).toBe('https:');
    expect(RETURN_HOSTS).toContain(new URL(out!).hostname);
  });
});

describe('safeSignInReturn: rejected (open-redirect boundary)', () => {
  it.each([
    ['empty', ''],
    ['null-ish', undefined],
    ['http, not https', 'http://wa.ebda.app/inbox'],
    ['protocol-relative', '//wa.ebda.app/inbox'],
    ['protocol-relative to evil', '//evil.example/x'],
    ['relative path', '/stores/abc'],
    ['relative without slash', 'wa.ebda.app/inbox'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>1</script>'],
    ['userinfo (allowlisted host as user)', 'https://wa.ebda.app@evil.example/x'],
    ['userinfo with password', 'https://user:pw@wa.ebda.app/x'],
    ['userinfo, user only', 'https://user@wa.ebda.app/x'],
    ['other port', 'https://wa.ebda.app:8443/x'],
    ['other port 80', 'https://wa.ebda.app:80/x'],
    ['backslash after scheme', 'https:\\\\wa.ebda.app\\x'],
    ['backslash trick', 'https://evil.example\\@wa.ebda.app/x'],
    ['backslash in path', 'https://wa.ebda.app/\\evil.example'],
    ['encoded backslash userinfo', 'https://wa.ebda.app%5c@evil.example/x'],
    ['lookalike suffix', 'https://wa.ebda.app.evil.example/x'],
    ['lookalike prefix', 'https://evilebda.app/x'],
    ['lookalike dash', 'https://wa-ebda.app/x'],
    ['unlisted subdomain', 'https://evil.ebda.app/x'],
    ['deeper subdomain', 'https://x.wa.ebda.app/x'],
    ['trailing-dot host', 'https://wa.ebda.app./x'],
    ['other tld', 'https://ebda.app.com/x'],
    ['punycode lookalike', 'https://xn--ebda-9ua.app/x'],
    ['unicode lookalike', 'https://ebdа.app/x'], // Cyrillic a
    ['ip host', 'https://127.0.0.1/x'],
    ['control character', 'https://wa.ebda.app/x\r\nSet-Cookie: a=b'],
    ['tab inside', 'https://wa.ebda.app/\t/evil'],
    ['space-led', ' https://evil.example/x'],
    ['store login (loop)', 'https://store.ebda.app/login'],
    ['store login subpath (loop)', 'https://store.ebda.app/login?returnTo=%2F'],
    ['absurdly long', 'https://wa.ebda.app/' + 'a'.repeat(3000)],
  ])('%s', (_name, url) => {
    expect(safeSignInReturn(url as string | undefined)).toBeNull();
  });
});

describe('signInProduct', () => {
  it('allows chat and store only; anything else is store', () => {
    expect(signInProduct('chat')).toBe('chat');
    expect(signInProduct('store')).toBe('store');
    for (const v of [null, undefined, '', 'CHAT', 'crm', 'chat ', '<script>', 'chat&x=1', 'orders'])
      expect(signInProduct(v as string | null | undefined)).toBe('store');
  });
});
