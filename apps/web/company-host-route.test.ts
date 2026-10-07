import { describe, it, expect } from 'vitest';
import { companyHostRoute, COMPANY_ORIGIN } from './company-host-route';

describe('companyHostRoute', () => {
  describe('company hosts', () => {
    it('301-redirects www.ebda.app to the bare apex, preserving path + query', () => {
      expect(companyHostRoute('www.ebda.app', '/', '')).toEqual({
        kind: 'redirect',
        location: 'https://ebda.app/',
        status: 301,
      });
      expect(companyHostRoute('www.ebda.app', '/privacy', '?ref=x')).toEqual({
        kind: 'redirect',
        location: 'https://ebda.app/privacy?ref=x',
        status: 301,
      });
    });

    it('reverse-proxies the bare apex ebda.app to the Pages origin', () => {
      expect(companyHostRoute('ebda.app', '/', '')).toEqual({
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
      // Platform subdomains and store subdomains.
      'admin.ebda.app',
      'orders.ebda.app',
      'api.ebda.app',
      'demo.ebda.app',
      // Look-alikes that must NOT be treated as the company host.
      'foo.ebda.app',
      'notebda.app',
      'ebda.app.evil.com',
      'wwwebda.app',
    ];

    it.each(passthroughHosts)('%s → next', host => {
      expect(companyHostRoute(host, '/', '')).toEqual({ kind: 'next' });
    });

    it('a merchant path on a store subdomain is untouched', () => {
      expect(companyHostRoute('pecannbee.ebda.app', '/products', '')).toEqual({
        kind: 'next',
      });
    });
  });
});
