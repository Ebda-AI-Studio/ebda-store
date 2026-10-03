/**
 * apps/marketing (ebda.app): nav, hero, section order, hreflang, trust surface,
 * pricing placeholders and brand hygiene. Renders the real components to static HTML.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Home } from '../../apps/marketing/src/components/Home';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import { pageMetadata, jsonLd } from '../../apps/marketing/src/lib/seo';
import { PLANS, PRICING_PUBLISHED } from '../../apps/marketing/src/lib/plans';
import { SECTION_ORDER, LOGIN_URL, SIGNUP_URL } from '../../apps/marketing/src/lib/site';

const pub = (f: string) =>
  readFileSync(path.resolve(__dirname, '../../apps/marketing/public', f), 'utf8');
const ar = renderToStaticMarkup(<Home locale="ar" />);
const en = renderToStaticMarkup(<Home locale="en" />);

describe('marketing nav', () => {
  it('has the five links in order with correct targets (en)', () => {
    const nav = en.match(/<nav aria-label="Main navigation".*?<\/nav>/s)![0];
    const labels = [...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].slice(0, 4);
    expect(labels.map(m => m[2])).toEqual(['Features', 'Solutions', 'Pricing', 'Resources']);
    expect(labels.map(m => m[1])).toEqual(['#builder', '#how', '#pricing', '#faq']);
  });
  it('Log in -> app login, Start selling -> app signup, in both locales', () => {
    expect(LOGIN_URL).toBe('https://app.ebda.app/login');
    expect(SIGNUP_URL).toBe('https://app.ebda.app/signup');
    for (const html of [ar, en]) {
      expect(html).toContain('<a href="https://app.ebda.app/login" class="link-login">');
      expect(html).toMatch(/<a href="https:\/\/app\.ebda\.app\/signup" class="btn btn-primary">/);
    }
    expect(en).toContain('>Log in<');
    expect(en).toContain('>Start selling<');
  });
  it('has a language toggle between / and /en', () => {
    expect(ar).toMatch(/href="\/en\/?"[^>]*hrefLang="en"|hrefLang="en"[^>]*href="\/en\/?"/i);
    expect(en).toMatch(/href="\/"[^>]*hrefLang="ar"|hrefLang="ar"[^>]*href="\/"/i);
  });
});

describe('marketing hero and structure', () => {
  it('shows the mandated hero copy', () => {
    for (const html of [ar, en]) {
      expect(html).toContain('ابدأ بيع أونلاين.');
      expect(html).toContain('Your business, your store, everything in one place.');
    }
  });
  it('renders sections in the exact required order', () => {
    const expected = [
      'create',
      'how',
      'builder',
      'products',
      'orders',
      'payments',
      'whatsapp',
      'analytics',
      'pricing',
      'stories',
      'faq',
      'login',
    ];
    expect([...SECTION_ORDER]).toEqual(expected);
    for (const html of [ar, en]) {
      const ids = [...html.matchAll(/<section id="([a-z]+)" class="section"/g)].map(m => m[1]);
      expect(ids).toEqual(expected);
    }
  });
  it('has landmarks: one h1, one main, header, footer, nav', () => {
    for (const html of [ar, en]) {
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html.match(/<main/g)).toHaveLength(1);
      expect(html).toContain('<header');
      expect(html).toContain('<footer');
    }
  });
  it('is Arabic RTL at / and English LTR at /en (lang/dir live in the shell)', () => {
    const shell = readFileSync(
      path.resolve(__dirname, '../../apps/marketing/src/components/RootShell.tsx'),
      'utf8'
    );
    expect(shell).toContain("dir={locale === 'ar' ? 'rtl' : 'ltr'}");
    expect(
      readFileSync(path.resolve(__dirname, '../../apps/marketing/src/app/(ar)/layout.tsx'), 'utf8')
    ).toContain('locale="ar"');
    expect(
      readFileSync(
        path.resolve(__dirname, '../../apps/marketing/src/app/(en)/en/layout.tsx'),
        'utf8'
      )
    ).toContain('locale="en"');
  });
});

describe('marketing honesty', () => {
  it('pricing is placeholders only: no amounts, driven by one config', () => {
    expect(PRICING_PUBLISHED).toBe(false);
    expect(PLANS.every(p => p.price === null)).toBe(true);
    const section = (h: string) => h.match(/<section id="pricing".*?<\/section>/s)![0];
    expect(section(en)).toContain('Pricing coming soon');
    expect(section(ar)).toContain('السعر قريبًا');
    expect(section(en).match(/EGP|ج\.م|\$/)).toBeNull();
    expect(section(en).match(/class="price">[^<]*\d/)).toBeNull();
  });
  it('payments mark unbuilt methods as coming and WhatsApp does not promise automation', () => {
    const pay = en.match(/<section id="payments".*?<\/section>/s)![0];
    expect(pay).toMatch(/Cards and wallets.*?badge-coming">Coming/s);
    expect(pay).toContain('InstaPay');
    expect(en).toContain('Automated messages: not available yet');
    expect(en).toMatch(/Bosta, Aramex and others are coming/);
  });
  it('first-merchant block carries no invented quote', () => {
    expect(en).toContain('data-testid="first-merchant"');
    expect(en).toContain('ameliaaurum.com');
    expect(en).not.toMatch(/<blockquote|&quot;.*Amelia/);
  });
});

describe('marketing SEO and trust surface', () => {
  it('emits hreflang alternates + canonical per locale', () => {
    const a = pageMetadata('ar', '').alternates!;
    expect(a.languages).toEqual({ ar: '/', en: '/en', 'x-default': '/' });
    expect(a.canonical).toBe('/');
    expect(pageMetadata('en', 'privacy').alternates!.languages).toMatchObject({
      ar: '/privacy',
      en: '/en/privacy',
    });
  });
  it('JSON-LD has Organization, WebSite, SoftwareApplication and no ratings', () => {
    const g = jsonLd('en')['@graph'];
    expect(g.map(n => n['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication']);
    expect(JSON.stringify(g)).not.toMatch(/aggregateRating|ratingValue|review|offers/i);
    expect(en).toContain('application/ld+json');
  });
  it('security.txt has Contact, a future Expires within a year, Canonical', () => {
    const t = pub('.well-known/security.txt');
    expect(t).toContain('Contact: mailto:security@ebda.app');
    const exp = new Date(/^Expires: (.+)$/m.exec(t)![1]).getTime();
    const now = Date.now();
    expect(exp).toBeGreaterThan(now);
    expect(exp).toBeLessThan(now + 366 * 24 * 3600 * 1000);
    expect(t).toContain('Canonical: https://ebda.app/.well-known/security.txt');
  });
  it('llms.txt and og assets exist; legal pages are marked DRAFT with no registration numbers', () => {
    expect(pub('llms.txt')).toMatch(/^# Ebda/);
    expect(pub('og.png').length).toBeGreaterThan(1000);
    for (const [locale, badge] of [
      ['ar', 'مسودة'],
      ['en', 'DRAFT'],
    ] as const) {
      for (const page of ['legal', 'privacy', 'terms'] as const) {
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />);
        expect(html).toContain(badge);
        expect(html).not.toMatch(/\b\d{5,}\b/);
      }
    }
  });
  it('no Force / FWB branding in any rendered page or public file', () => {
    const bad = /Force AI|ForceAI|Force Website Builder|force-ai|\bFWB\b|\bForce\b/i;
    const all = [ar, en, pub('llms.txt'), pub('.well-known/security.txt'), pub('og.svg')];
    for (const p of ['legal', 'privacy', 'terms'] as const)
      for (const l of ['ar', 'en'] as const)
        all.push(renderToStaticMarkup(<LegalPage locale={l} page={p} />));
    for (const s of all) expect(s).not.toMatch(bad);
  });
});
