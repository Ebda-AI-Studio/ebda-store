/**
 * 404-1b: reserved / unserved hosts under .ebda.app answer with Ebda AI Studio's branded page, never plain text.
 * Per host: status, noindex, the search box, the right links, language, and that no store is ever named.
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

function hit(host: string, path = '/', headers: Record<string, string> = {}) {
  return middleware(new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } }));
}

describe('studio pages on hosts nobody serves', () => {
  it.each([
    ['crm.ebda.app', 'Ebda CRM is coming soon.'],
    ['erp.ebda.app', 'Ebda ERP is coming soon.'],
    ['wa.ebda.app', 'Ebda Chat is coming soon.'],
    ['whatsapp.ebda.app', 'Ebda Chat is coming soon.'],
    ['hub.ebda.app', 'This address is held for an upcoming service from Ebda AI Studio.'],
    ['id.ebda.app', 'This address is held for an upcoming service from Ebda AI Studio.'],
  ])('%s: 200 coming soon, noindex, search box, live links', async (host, line) => {
    const res = hit(host, '/', { 'accept-language': 'en-US,en;q=0.9' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    const html = await res.text();
    expect(html).toContain(line);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toMatch(
      /<form class="search" role="search" action="https:\/\/help\.ebda\.app\/en\/search\/"/
    );
    expect(html).toContain('type="search"');
    for (const href of [
      'https://ebda.app/',
      'https://status.ebda.app/',
      'https://docs.ebda.app/',
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it.each(['app.ebda.app', 'admin.ebda.app', 'billing.ebda.app', 'ab.ebda.app'])(
    '%s: a REAL 404 (not a soft 200), noindex, branded html',
    async host => {
      const res = hit(host);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      const html = await res.text();
      expect(html).toContain('الصفحة اللي بتدوّر عليها مش موجودة.'); // Arabic is the default
      expect(html).toContain('dir="rtl"');
      expect(html).toContain('role="search"');
    }
  );

  it('English on request, Egyptian Arabic otherwise, ?lang wins', async () => {
    const en = await hit('app.ebda.app', '/', { 'accept-language': 'en' }).text();
    expect(en).toContain('The page you&#39;re looking for can&#39;t be found.');
    expect(en).toContain('dir="ltr"');
    const forced = await hit('app.ebda.app', '/?lang=ar', { 'accept-language': 'en' }).text();
    expect(forced).toContain('dir="rtl"');
  });

  it('is calm: no orange anywhere, one script (the help typeahead), locked-down CSP', async () => {
    const res = hit('crm.ebda.app');
    const html = await res.text();
    expect(html.toLowerCase()).not.toMatch(/orange|#ff6e01|#f60|#ff8c00/);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script src="https://help.ebda.app/assets/typeahead.js" defer>');
    expect(html).toContain('data-sources=');
    expect(html).toContain('https://docs.ebda.app/search-index.en.json');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src https://help.ebda.app');
  });

  it('never names or suggests a store', async () => {
    const html = await hit('app.ebda.app').text();
    expect(html).not.toMatch(/storedemo|\.ebda\.app\/products/);
  });

  it('junk hosts stay a plain 404 (no studio page for an IP or another zone)', async () => {
    for (const host of ['127.0.0.1', 'localhost', 'a.b.ebda.app']) {
      const res = hit(host);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/plain');
    }
  });
});
