import { describe, it, expect } from 'vitest';
import { companyHostRoute, COMPANY_ORIGIN } from './company-host-route';

describe('companyHostRoute', () => {
  describe('company hosts', () => {
    it('301-redirects www.force-ai.co to the bare apex, preserving path + query', () => {
      expect(companyHostRoute('www.force-ai.co', '/', '')).toEqual({
        kind: 'redirect',
        location: 'https://force-ai.co/',
        status: 301,
      });
      expect(companyHostRoute('www.force-ai.co', '/privacy', '?ref=x')).toEqual({
        kind: 'redirect',
        location: 'https://force-ai.co/privacy?ref=x',
        status: 301,
      });
    });

    it('reverse-proxies the bare apex force-ai.co to the Pages origin', () => {
      expect(companyHostRoute('force-ai.co', '/', '')).toEqual({
        kind: 'proxy',
        origin: COMPANY_ORIGIN,
      });
    });
  });

  // The whole point of this test: the shared platform Worker must NOT touch any
  // merchant domain or platform subdomain — they all fall through to Next.
  describe('everything else falls through to Next (merchants unaffected)', () => {
    const passthroughHosts = [
      // Real merchant custom domains — MUST keep working exactly as before.
      'pecannbee.com',
      'www.pecannbee.com',
      'wadyaljuz.com',
      'www.wadyaljuz.com',
      // Platform subdomains.
      'store.force-ai.co',
      'admin.force-ai.co',
      'orders.force-ai.co',
      // Look-alikes that must NOT be treated as the company host.
      'foo.force-ai.co',
      'notforce-ai.co',
      'force-ai.co.evil.com',
      'wwwforce-ai.co',
    ];

    it.each(passthroughHosts)('%s → next', host => {
      expect(companyHostRoute(host, '/', '')).toEqual({ kind: 'next' });
    });

    it('a merchant path on store.force-ai.co is untouched', () => {
      expect(companyHostRoute('store.force-ai.co', '/pecannbee', '')).toEqual({
        kind: 'next',
      });
    });
  });
});
