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
import { AboutPage } from '../../apps/marketing/src/components/AboutPage';
import sitemap from '../../apps/marketing/src/app/sitemap';
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
    expect(labels.map(m => m[1])).toEqual(['#features', '#how', '#pricing', '#faq']);
  });
  it('Log in -> app login, Start now -> app signup, in both locales', () => {
    expect(LOGIN_URL).toBe('https://store.ebda.app/login');
    expect(SIGNUP_URL).toBe('https://store.ebda.app/signup');
    for (const html of [ar, en]) {
      expect(html).toContain('<a href="https://store.ebda.app/login" class="link-login">');
      expect(html).toMatch(/<a href="https:\/\/store\.ebda\.app\/signup" class="btn btn-primary">/);
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
    const expected = [
      'story',
      'how',
      'templates',
      'breakout',
      'dahab',
      'features',
      'payments',
      'about',
      'pricing',
      'faq',
      'start',
    ];
    expect([...SECTION_ORDER]).toEqual(expected);
    for (const html of [ar, en]) {
      const ids = [
        ...html.matchAll(/<section id="([a-z]+)" class="(?:section|story|breakout)[" ]/g),
      ].map(m => m[1]);
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
  it('brand line, footer ownership line and Western digits everywhere', () => {
    expect(ar).toContain('ابدأ ستوديو — بابك لبدء مشروعك.');
    expect(en).toContain('Ebda AI Studio — Your doorway to business.');
    expect(en).toContain(
      'Ebda Store is a product of Ebda AI Studio. © 2026 Ebda AI Studio. All rights reserved.'
    );
    expect(ar).toContain('ابدأ ستور منتج من ابدأ ستوديو. © 2026 ابدأ ستوديو. جميع الحقوق محفوظة.');
    // no Arabic-Indic digits anywhere on either home page or any legal page
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(en).not.toMatch(/[٠-٩]/);
    for (const l of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS)
        expect(renderToStaticMarkup(<LegalPage locale={l} page={page} />)).not.toMatch(/[٠-٩]/);
    // 3D product models: included on every plan
    const row = en.match(/<tr><th scope="row">3D product models<\/th>.*?<\/tr>/s)![0];
    expect(row.match(/class="yes"/g)).toHaveLength(3);
  });
  it('the legal notice and terms name the operator without a personal name', () => {
    const ln = renderToStaticMarkup(<LegalPage locale="en" page="legal" />);
    expect(ln).toContain(
      'The Service is a technology platform owned and operated by Ebda AI Studio'
    );
    const lar = renderToStaticMarkup(<LegalPage locale="ar" page="terms" />);
    expect(lar).toContain('اتفاق بينك وبين ابدأ ستوديو');
    for (const l of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS) {
        const h = renderToStaticMarkup(<LegalPage locale={l} page={page} />);
        expect(h).not.toMatch(/Ahmad|أحمد|Sharaf|شرف/);
      }
  });
  it('the new motion sections ship their real assets and accessible controls', () => {
    for (const html of [ar, en]) {
      // four numbered steps, a real sequence
      expect(html.match(/class="step4"/g)).toHaveLength(4);
      expect(html).toContain('>01<');
      // 3D ring: poster first, swatches are real buttons with pressed state
      expect(html).toContain('/ring/ring-gold-diamond.webp');
      expect(html.match(/class="swatch"/g)).toHaveLength(6);
      expect(html).toMatch(
        /aria-pressed="true"[^>]*data-metal="gold"|data-metal="gold"[^>]*aria-pressed="true"/
      );
      // notification stream: four toasts
      expect(html.match(/class="story-toast"/g)).toHaveLength(4);
    }
    expect(ar).toContain('بوسطة استلمت الشحنة');
    expect(ar).toContain('وصلك دفع إنستا باي');
  });
  it('shows ONE real store (Dahab) on every device, high-res, and no food anywhere', () => {
    // Real storefront captures (apps/web) at true device sizes, never a hand-made mock.
    for (const d of ['phone-600', 'phone-900', 'tablet-840', 'laptop-1280', 'laptop-1920'])
      expect(en).toContain(`/devices/dahab-${d}.webp`);
    expect(en).toContain('/devices/dahab-story-900.webp');
    for (const html of [ar, en]) {
      expect(html).not.toMatch(/souq-|qamar-|lamma-|jasmine-|data-pal=/);
      // no template switcher promising looks that are not shown
      expect(html).not.toMatch(/tpl-tab|Five templates|خمس قوالب/);
    }
    expect(ar).not.toMatch(/كيكة|أكل بيتي|طبيخ|محشي|ورق عنب/);
    expect(en).not.toMatch(/cake|home-food|home food|kitchen/i);
    expect(en).not.toMatch(/lorem|placeholder/i);
  });
  it('prices use Western digits and ج.م on the Arabic page', () => {
    const s = ar.match(/<section id="pricing".*?<\/section>/s)![0];
    expect(s).toContain('1,490 ج.م');
    expect(s).not.toMatch(/[٠-٩]/);
  });
  it('no customer-facing surface names the old operator or links whisky11.com; JSON-LD names Ebda AI Studio', () => {
    const pages = LEGAL_SLUGS.flatMap(page =>
      (['ar', 'en'] as const).map(l => renderToStaticMarkup(<LegalPage locale={l} page={page} />))
    );
    for (const html of [ar, en, ...pages]) expect(html).not.toMatch(/whisky/i);
    const org = jsonLd('en')['@graph'][0] as Record<string, unknown>;
    expect(org.name).toBe('Ebda AI Studio');
    expect(org.alternateName).toBe('ابدأ ستوديو');
    expect(org.url).toBe('https://ebda.app');
    expect(org).not.toHaveProperty('parentOrganization');
    expect(JSON.stringify(org)).not.toMatch(/whisky/i);
  });
  it('the about page carries the company line, the story and both contact addresses', () => {
    for (const l of ['ar', 'en'] as const) {
      const html = renderToStaticMarkup(<AboutPage locale={l} />);
      expect(html).toContain(
        l === 'en' ? 'owned and operated by Ebda AI Studio' : 'مملوكة لابدأ ستوديو'
      );
      expect(html).toContain('ahlan@ebda.app');
      expect(html).toContain('security@ebda.app');
      expect(html).not.toMatch(/whisky/i);
    }
  });
  it('the about page is in the sitemap for both locales', () => {
    const urls = sitemap().map(e => e.url);
    expect(urls).toContain('https://ebda.app/about/');
    expect(urls).toContain('https://ebda.app/en/about/');
  });
  it('shows no named merchant or invented quote until one has a live store', () => {
    expect(en).not.toContain('data-testid="first-merchant"');
    expect(en).not.toContain('ameliaaurum.com');
    expect(en).not.toMatch(/<blockquote/);
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
