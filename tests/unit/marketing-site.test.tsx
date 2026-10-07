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
import {
  LEGAL_SLUGS,
  SECTION_ORDER,
  LOGIN_URL,
  SIGNUP_URL,
} from '../../apps/marketing/src/lib/site';

const pub = (f: string) =>
  readFileSync(path.resolve(__dirname, '../../apps/marketing/public', f), 'utf8');
const ar = renderToStaticMarkup(<Home locale="ar" />);
const en = renderToStaticMarkup(<Home locale="en" />);

describe('marketing nav', () => {
  it('has the five links in order with correct targets (en)', () => {
    const nav = en.match(/<nav aria-label="Main navigation".*?<\/nav>/s)![0];
    const labels = [...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].slice(0, 4);
    expect(labels.map(m => m[2])).toEqual(['Features', 'How it works', 'Pricing', 'FAQ']);
    expect(labels.map(m => m[1])).toEqual(['#features', '#story', '#pricing', '#faq']);
  });
  it('Log in -> app login, Start now -> app signup, in both locales', () => {
    expect(LOGIN_URL).toBe('https://admin.ebda.app/login');
    expect(SIGNUP_URL).toBe('https://admin.ebda.app/signup');
    for (const html of [ar, en]) {
      expect(html).toContain('<a href="https://admin.ebda.app/login" class="link-login">');
      expect(html).toMatch(/<a href="https:\/\/admin\.ebda\.app\/signup" class="btn btn-primary">/);
    }
    expect(en).toContain('>Log in<');
    expect(en).toContain('>Start now<');
    expect(ar).toContain('>ابدأ دلوقتي<');
  });
  it('has a language toggle between / and /en', () => {
    expect(ar).toMatch(/href="\/en\/?"[^>]*hrefLang="en"|hrefLang="en"[^>]*href="\/en\/?"/i);
    expect(en).toMatch(/href="\/"[^>]*hrefLang="ar"|hrefLang="ar"[^>]*href="\/"/i);
  });
});

describe('marketing hero and structure', () => {
  it('shows the hero in each locale (Egyptian Arabic at /, English at /en)', () => {
    expect(ar).toContain('ابدأ متجرك أونلاين في دقايق.');
    expect(en).toContain('Open your online store in minutes.');
    // No English sentence on the Arabic hero any more (R-EBDA-COPY-1).
    expect(ar).not.toContain('Your business, your store');
  });
  it('renders sections in the exact required order', () => {
    const expected = ['story', 'templates', 'features', 'payments', 'pricing', 'faq', 'start'];
    expect([...SECTION_ORDER]).toEqual(expected);
    for (const html of [ar, en]) {
      const ids = [...html.matchAll(/<section id="([a-z]+)" class="(?:section|story)[" ]/g)].map(
        m => m[1]
      );
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
  const section = (h: string) => h.match(/<section id="pricing".*?<\/section>/s)![0];
  it('pricing shows the locked EGP prices in both languages, driven by one config', () => {
    expect(PRICING_PUBLISHED).toBe(true);
    expect(PLANS.map(p => p.price?.amountMinor)).toEqual([149000, 349000, 999000]);
    for (const html of [en, ar]) {
      const s = section(html).replace(/[\s\u00a0\u202f,٬،.]/g, '');
      // Latin or Arabic-Indic digits: 1,490 / 3,490 / 9,990 per month
      expect(s).toMatch(/1490|١٤٩٠/);
      expect(s).toMatch(/3490|٣٤٩٠/);
      expect(s).toMatch(/9990|٩٩٩٠/);
    }
    expect(section(en)).not.toContain('Pricing coming soon');
    expect(section(ar)).not.toContain('السعر قريبًا');
  });
  it('each plan card links to signup with its plan and both intervals', () => {
    for (const html of [en, ar]) {
      const s = section(html);
      for (const id of ['basic', 'growth', 'business']) {
        expect(s).toContain(`href="${SIGNUP_URL}?plan=${id}&amp;interval=month"`);
        expect(s).toContain(`href="${SIGNUP_URL}?plan=${id}&amp;interval=year"`);
      }
    }
    expect(section(en)).toContain('Start with Growth');
    expect(section(ar)).toContain('ابدأ بباقة النمو');
  });
  it('presents every payment and shipping provider as available, with no "coming soon" anywhere', () => {
    for (const html of [en, ar]) {
      const pay = html.match(/<section id="payments".*?<\/section>/s)![0];
      for (const logo of [
        'paymob',
        'kashier',
        'fawrypay',
        'instapay',
        'bosta',
        'shipblu',
        'mylerz',
        'aramex',
      ])
        expect(pay).toContain(`/logos/${logo}.webp`);
      // Transparent marks in one ink: no tiles or cards behind them.
      expect(pay).not.toMatch(/class="plate/);
      expect(pay).toMatch(/Cash on delivery|الدفع عند الاستلام/);
      expect(pay).toMatch(/Your own delivery|توصيل بنفسك/);
      expect(pay).toContain('mailto:ahlan@ebda.app');
    }
    expect(en).not.toMatch(/coming soon/i);
    expect(ar).not.toMatch(/>قريب</);
    expect(ar).not.toContain('السعر قريب');
  });
  it('the pricing table is built from the shared plan catalogue (every public limit)', () => {
    const s = en.match(/<table class="compare">.*?<\/table>/s)![0];
    for (const label of [
      'Orders a month',
      'Team members',
      'Stores',
      'Abandoned cart recovery',
      'API and MCP access',
      'Analytics',
      'Support',
    ])
      expect(s).toContain(label);
    expect(s).toContain('EGP 13,410');
    expect(s).toContain('EGP 89,910');
  });
  it('the five template families show real storefront captures', () => {
    for (const id of ['souq', 'dahab', 'qamar', 'lamma', 'jasmine'])
      expect(en).toContain(`data-pal="${id}"`);
    // Real storefront captures (apps/web) at true device sizes, never a hand-made mock.
    for (const d of ['phone-600', 'tablet-840', 'laptop-1280'])
      expect(en).toContain(`/devices/souq-${d}.webp`);
    expect(en).toContain('/devices/lamma-story-600.webp');
    expect(en).not.toMatch(/lorem|placeholder/i);
  });
  it('prices use Western digits and ج.م on the Arabic page', () => {
    const s = ar.match(/<section id="pricing".*?<\/section>/s)![0];
    expect(s).toContain('1,490 ج.م');
    expect(s).not.toMatch(/[٠-٩]/);
  });
  it('every Whisky 11 mention in the footer links to whisky11.com in a new tab', () => {
    for (const html of [ar, en]) {
      expect(html).toContain(
        '<a href="https://whisky11.com" target="_blank" rel="noopener noreferrer">Whisky 11</a>'
      );
    }
    const org = jsonLd('en')['@graph'][0] as { parentOrganization: { url: string } };
    expect(org.parentOrganization.url).toBe('https://whisky11.com');
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
  it('JSON-LD has Organization, WebSite, SoftwareApplication, FAQPage and no ratings', () => {
    const g = jsonLd('en')['@graph'];
    expect(g.map(n => n['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
      'FAQPage',
    ]);
    expect(JSON.stringify(g)).not.toMatch(/aggregateRating|ratingValue|"review"/i);
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
  it('llms.txt and og assets exist; legal pages show their version with no registration numbers', () => {
    expect(pub('llms.txt')).toMatch(/^# Ebda/);
    expect(pub('og.png').length).toBeGreaterThan(1000);
    for (const [locale, badge] of [
      ['ar', 'الإصدار 1.0'],
      ['en', 'Version 1.0'],
    ] as const) {
      for (const page of LEGAL_SLUGS) {
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />);
        expect(html).toContain(badge);
        expect(html).not.toMatch(/\b\d{5,}\b/);
      }
    }
  });
  it('every legal page (both locales) is versioned, names the contact, and has no placeholders', () => {
    for (const locale of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS) {
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />);
        expect(html).toContain('2026-10-07');
        expect(html).toContain('ahlan@ebda.app');
        expect(html).not.toMatch(/\[[^\]]*\]/);
        expect(html.match(/<section/g)!.length).toBeGreaterThanOrEqual(5);
      }
  });
  it('sitemap lists every legal page in both locales', async () => {
    const { default: sitemap } = await import('../../apps/marketing/src/app/sitemap');
    const urls = sitemap().map(e => e.url);
    for (const slug of LEGAL_SLUGS) {
      expect(urls).toContain(`https://ebda.app/${slug}/`);
      expect(urls).toContain(`https://ebda.app/en/${slug}/`);
    }
  });
  it('no inherited third-party branding in any rendered page or public file', () => {
    const bad = /Force AI|ForceAI|Force Website Builder|force-ai|\bFWB\b|\bForce\b/i;
    const all = [ar, en, pub('llms.txt'), pub('.well-known/security.txt'), pub('og.svg')];
    for (const p of LEGAL_SLUGS)
      for (const l of ['ar', 'en'] as const)
        all.push(renderToStaticMarkup(<LegalPage locale={l} page={p} />));
    for (const s of all) expect(s).not.toMatch(bad);
  });
});
