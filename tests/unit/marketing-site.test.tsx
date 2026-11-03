/**
 * apps/marketing (ebda.app): nav, hero, section order, hreflang, trust surface,
 * pricing placeholders and brand hygiene. Renders the real components to static HTML.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Home } from '../../apps/marketing/src/components/Home';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import { AboutPage } from '../../apps/marketing/src/components/AboutPage';
import sitemap from '../../apps/marketing/src/app/sitemap';
import { pageMetadata, jsonLd } from '../../apps/marketing/src/lib/seo';
import { PLANS, PRICING_PUBLISHED } from '../../apps/marketing/src/lib/plans';
import {
  LEGAL_SLUGS,
  DEMO_STORES,
  SECTION_ORDER,
  LOGIN_URL,
  SIGNUP_URL,
} from '../../apps/marketing/src/lib/site';
import {
  LEGAL_POLICIES,
  LEGAL_DOC_TITLE,
  LEGAL_DOC_SLUG,
  currentLegalVersion,
  formatLegalDate,
  type LegalDocKey,
} from '../../packages/shared/src/legal';
import { COPY } from '../../apps/marketing/src/lib/content';

const DOC_OF: Record<(typeof LEGAL_SLUGS)[number], LegalDocKey> = {
  legal: 'legal',
  privacy: 'privacy',
  terms: 'terms',
  'merchant-agreement': 'merchant',
  'acceptable-use': 'acceptableUse',
};

const pub = (f: string) =>
  readFileSync(path.resolve(__dirname, '../../apps/marketing/public', f), 'utf8');
const ar = renderToStaticMarkup(<Home locale="ar" />);
const en = renderToStaticMarkup(<Home locale="en" />);

describe('marketing nav', () => {
  it('names the product (not the studio) in both marketing page titles', () => {
    expect(pageMetadata('ar', 'store').title).toContain('ابدأ ستور');
    expect(pageMetadata('en', 'store').title).toContain('Ebda Store');
    // the product leads and the studio is not named in the title (the brand line is in OG + JSON-LD)
    for (const l of ['ar', 'en'] as const) {
      const t = String(pageMetadata(l, 'store').title);
      expect(t.length).toBeLessThanOrEqual(60);
      expect(t).not.toMatch(/Ebda AI Studio|ابدأ ستوديو/);
    }
  });
  it('has the five links in page order with correct targets (en)', () => {
    const nav = en.match(/<nav aria-label="Main navigation".*?<\/nav>/s)![0];
    const labels = [...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].slice(0, 5);
    expect(labels.map(m => m[2])).toEqual([
      'How it works',
      'Templates',
      'Features',
      'Pricing',
      'FAQ',
    ]);
    expect(labels.map(m => m[1])).toEqual(['#story', '#looks', '/en/features', '#pricing', '#faq']);
    // every nav target exists on the page, in the same order as the sections
    const at = (id: string) => en.indexOf(`<section id="${id}"`);
    // "Features" is the real /features page, not a home section
    const pos = labels.filter(m => m[1].startsWith('#')).map(m => at(m[1].slice(1)));
    expect(pos.every(p => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });
  it('header: the master brand lockup plus a Products menu naming only the live products, Ebda Store and Ebda Chat (BRAND-ARCH-1)', () => {
    for (const [html, studio, store, wa, soon] of [
      [ar, 'ابدأ ستوديو للذكاء الاصطناعي', 'ابدأ ستور', 'ابدأ شات', /قريب/],
      [en, 'Ebda AI Studio', 'Ebda Store', 'Ebda Chat', /coming soon/i],
    ] as const) {
      const wm = html.match(/<a class="wordmark".*?<\/a>/s)![0];
      expect(wm).toContain(`>${studio}</span>`);
      const menu = html.match(/<li class="nav-products">.*?<\/details>/s)![0];
      expect(menu).toContain(`<b>${store}</b>`);
      expect(menu).toContain(`<b>${wa}</b>`);
      expect(menu.match(/<a /g)).toHaveLength(2);
      expect(menu).not.toMatch(soon);
      expect(menu).not.toMatch(/CRM|ERP/);
    }
  });
  it('footer: no competitor compare links (Ahmad 2026-10-23)', () => {
    for (const html of [ar, en]) {
      const footer = html.match(/<footer class="site-footer.*?<\/footer>/s)![0];
      expect(footer).not.toMatch(/href="[^"]*\/compare\//);
    }
  });
  it('Log in -> app login, Start now -> app signup, in both locales', () => {
    expect(LOGIN_URL).toBe('https://store.ebda.app/login');
    expect(SIGNUP_URL).toBe('https://store.ebda.app/signup');
    for (const html of [ar, en]) {
      // the conversion path continues in the SAME tab (audit UI-15): no target, no new-tab note
      expect(html).toMatch(/<a href="https:\/\/store\.ebda\.app\/login" class="link-login">/);
      expect(html).toMatch(
        /<a href="https:\/\/store\.ebda\.app\/signup" class="btn btn-primary header-start">/
      );
    }
    expect(en).toContain('>Log in<');
    expect(en).toContain('>Start now<');
    expect(ar).toContain('>ابدأ دلوقتي<');
  });
  it('has a language toggle between / and /en', () => {
    expect(ar).toMatch(
      /href="\/en\/store\/?"[^>]*hrefLang="en"|hrefLang="en"[^>]*href="\/en\/store\/?"/i
    );
    expect(en).toMatch(/href="\/store"[^>]*hrefLang="ar"|hrefLang="ar"[^>]*href="\/store"/i);
  });
});

describe('marketing hero and structure', () => {
  it('shows the hero in each locale (Egyptian Arabic at /, English at /en)', () => {
    expect(ar).toContain('ابدأ متجرك أونلاين في دقايق.');
    expect(en).toContain('Open your online store in minutes.');
    // No English sentence on the Arabic hero any more (R-EBDA-COPY-1).
    expect(ar).not.toContain('Your business, your store');
  });
  it('hero = one promise + sub naming the product + ONE button, no second link, one decorative finished-store phone (MKT-1, HERO-LAYOUT-1, 6b)', () => {
    for (const [html, name] of [
      [ar, 'ابدأ ستور بيديك'],
      [en, 'Ebda Store gives you'],
    ] as const) {
      const hero = html.match(/<section class="hero".*?<\/section>/s)![0];
      expect(hero).toContain(name);
      expect(hero.match(/class="btn btn-primary btn-lg"/g)).toHaveLength(1);
      expect(hero).toContain(`href="${SIGNUP_URL}"`);
      expect(hero.match(/<a /g)).toHaveLength(1); // one promise, one button
      // HERO-LAYOUT-1 (supersedes MKT-10's "no hero phone"): exactly one decorative phone, the finished story frame
      expect(hero.match(/class="dev-phone hero-phone"/g)).toHaveLength(1);
      expect(hero).toContain('class="hero-visual" aria-hidden="true"');
      expect(hero).toContain('dahab-story-4-900');
      expect(hero).not.toMatch(/look-phone|class="scr"|id="hp-/);
      // the retired hero furniture is gone: particles, poster, studio kicker, slug pill
      expect(hero).not.toMatch(/nile|hero-poster|hero-brand|slug-pill|<canvas/);
      expect(hero).not.toMatch(/ابدأ ستوديو للذكاء|Ebda AI Studio/);
    }
  });
  it('the retired sections and their assets are gone; the story stays with the new Dahab frames (MKT-1)', () => {
    for (const html of [ar, en]) {
      expect(html).not.toMatch(
        /id="breakout"|id="about"|id="how"|bo-ring|steps4|story-strip|story-bar/
      );
      // the story is kept, re-skinned: one Dahab look A frame per step, server renders the last
      expect(html.match(/class="story-frame"/g)).toHaveLength(4);
      for (const n of [1, 2, 3, 4]) expect(html).toContain(`/devices/dahab-story-${n}-900.webp`);
      expect(html).not.toMatch(/dahab-story-900|dahab-bar/);
    }
    const dev = path.resolve(__dirname, '../../apps/marketing/public/devices');
    for (const n of [1, 2, 3, 4])
      for (const ext of ['avif', 'webp'])
        expect(existsSync(`${dev}/dahab-story-${n}-900.${ext}`)).toBe(true);
    for (const old of ['dahab-story-900', 'dahab-bar-900'])
      for (const ext of ['avif', 'webp']) expect(existsSync(`${dev}/${old}.${ext}`)).toBe(false);
    for (const f of [
      'src/components/Breakout.tsx',
      'src/components/NileNight.tsx',
      'src/lib/device-shots.ts',
      'scripts/storefront-capture',
    ])
      expect(existsSync(path.resolve(__dirname, '../../apps/marketing', f))).toBe(false);
    expect(
      existsSync(path.resolve(__dirname, '../../apps/marketing/scripts/story-frames/make.mjs'))
    ).toBe(true);
  });
  it('MKT-15 (merged into #looks): no separate demo section, one #demo anchor, live links for all three demo stores', () => {
    for (const html of [ar, en]) {
      expect(html).not.toContain('<section id="demo"');
      expect(html.match(/id="demo"/g)).toHaveLength(1);
    }
    for (const lang of ['ar', 'en'] as const)
      for (const [tpl, { host, looks }] of Object.entries(DEMO_STORES)) {
        expect(COPY[lang].looks.items[tpl]).toHaveLength(3);
        expect(looks).toHaveLength(3);
        expect(host.startsWith('storedemo')).toBe(true);
      }
  });
  it('renders sections in the exact required order', () => {
    // MKT-14 (Ahmad 2026-10-14): story first, then the looks
    const expected = [
      'story',
      'looks',
      'model3d',
      'payments',
      'features',
      'ainative',
      'capabilities',
      'pricing',
      'faq',
      'start',
    ];
    expect([...SECTION_ORDER]).toEqual(expected);
    for (const html of [ar, en]) {
      const ids = [...html.matchAll(/<section id="([a-z0-9]+)" class="(?:section|story)[" ]/g)].map(
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
    // "coming soon" now exists, honestly, for registry items (capability-registry.ts), but never in the
    // payments or pricing sections, and never as the pricing placeholder
    for (const [html, soon] of [
      [en, /coming soon/i],
      [ar, /قريبًا/],
    ] as const)
      for (const id of ['payments', 'pricing']) {
        expect(html.match(new RegExp(`<section id="${id}".*?</section>`, 's'))![0]).not.toMatch(
          soon
        );
      }
    expect(ar).not.toContain('السعر قريب');
  });
  it('the pricing table is built from the shared plan catalogue (every public limit)', () => {
    const s = en.match(/<table class="compare">.*?<\/table>/s)![0];
    for (const label of [
      'Orders a month',
      'Team members',
      'Stores',
      'Win back shoppers who left their cart',
      'Run your store from an AI assistant',
      'Analytics',
      'Support',
    ])
      expect(s).toContain(label);
    expect(s).toContain('EGP 13,410');
    expect(s).toContain('EGP 89,910');
  });
  it('footer ownership line, studio credit and Western digits everywhere', () => {
    // the studio's line moved off the home page to /about (MKT-1); the footer carries a one-line credit
    expect(renderToStaticMarkup(<AboutPage locale="ar" />)).toContain(
      'ابدأ ستوديو للذكاء الاصطناعي — بابك لبدء مشروعك.'
    );
    expect(renderToStaticMarkup(<AboutPage locale="en" />)).toContain(
      'Ebda AI Studio — Your doorway to business.'
    );
    expect(en).toContain('<p class="footer-credit">Ebda Store — a product of Ebda AI Studio</p>');
    expect(ar).toContain('منتج من ابدأ ستوديو للذكاء الاصطناعي</p>');
    expect(en).toContain(
      'Ebda Store is a product of Ebda AI Studio. © 2026 Ebda AI Studio. All rights reserved.'
    );
    expect(ar).toContain(
      'ابدأ ستور منتج من ابدأ ستوديو للذكاء الاصطناعي. © 2026 ابدأ ستوديو للذكاء الاصطناعي. جميع الحقوق محفوظة.'
    );
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
    expect(lar).toContain('اتفاق بينك وبين ابدأ ستوديو للذكاء الاصطناعي');
    for (const l of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS) {
        const h = renderToStaticMarkup(<LegalPage locale={l} page={page} />);
        expect(h).not.toMatch(/Ahmad|أحمد|Sharaf|شرف/);
      }
  });
  it('the four steps appear once (in the story, each with its one-line how)', () => {
    for (const html of [ar, en]) {
      const story = html.match(/<section id="story".*?<\/section>/s)![0];
      expect(story.match(/<li data-n="/g)).toHaveLength(4);
      expect(story.match(/class="story-step-d"/g)).toHaveLength(4);
      // the separate how band is gone: no second numbered list of the same four steps
      expect(html.match(/<ol class="/g)!.length).toBe(2); // story steps + story toasts
      // the order notifications at the end of the story
      expect(story.match(/class="story-toast"/g)).toHaveLength(4);
    }
    expect(ar).toContain('اختار اسم ولوجو.');
    // plain words: an Excel file, not "CSV"
    expect(ar).toContain('بالصور والأسعار والمقاسات، أو من ملف إكسل.');
    expect(en).toContain('Photos, prices and sizes, or an Excel file.');
    expect(ar).toContain('بوسطة استلمت الشحنة');
    expect(en).toContain('Pick a name and logo.');
  });
  it('the 3D section replaces the ring: still first, chips, colour swatches, no credit line under it, QR, no ring left', () => {
    for (const [html, locale] of [
      [ar, 'ar'],
      [en, 'en'],
    ] as const) {
      const sec = html.match(/<section id="model3d".*?<\/section>/s)![0];
      expect(sec).toContain('/3d/stills/qamar-midnight.webp'); // the still is the server-rendered first paint
      expect(sec.match(/role="tab"/g)).toHaveLength(5);
      expect(sec).toContain(`/3d/qr/qamar-${locale}.svg`);
      // the three glTF colourways are real buttons with a pressed state and visible text
      expect(sec.match(/class="m3d-swatch"/g)).toHaveLength(3);
      expect(sec).toMatch(
        /aria-pressed="true"[^>]*class="m3d-swatch"|class="m3d-swatch"[^>]*aria-pressed="true"/
      );
      // MKT-12: no credit line under the viewer; the CC BY 4.0 attribution lives on /credits, linked from the
      // footer (tests/unit/marketing-model3d.test.ts guards it, so it can never just disappear)
      expect(sec).not.toMatch(/Shopify|m3d-credit|CC BY/);
      expect(html).toMatch(locale === 'ar' ? /href="\/credits\/?"/ : /href="\/en\/credits\/?"/);
      expect(html).not.toMatch(/\/ring\/|class="swatch"|ring-stage|id="dahab"/);
    }
    expect(ar).toContain('خلّي عميلك يقلّب المنتج بإيده.');
    expect(en).toContain('Let shoppers turn it in their hands.');
  });
  it('pricing on phones: a radio-group plan switcher (growth checked) and the comparison collapsed in a details', () => {
    for (const html of [ar, en]) {
      const pr = html.match(/<section id="pricing".*?<\/section>/s)![0];
      expect(pr.match(/<input type="radio" name="plan-pick"/g)).toHaveLength(3);
      expect(pr).toMatch(/id="pick-growth" checked=""/);
      expect(pr).not.toMatch(/id="pick-(basic|business)" checked/);
      for (const id of ['basic', 'growth', 'business'])
        expect(pr).toContain(`<label for="pick-${id}">`);
      expect(pr).toMatch(
        /<details class="compare-details"><summary>(قارن الباقات|Compare plans)<\/summary>/
      );
      expect(pr).not.toMatch(/<details class="compare-details" open/);
    }
  });
  it("plan bullets are plain words and match each plan's real entitlements", () => {
    const all = JSON.stringify(PLANS.map(p => p.features));
    expect(all).not.toMatch(/MCP|API|CSV|Powered by|مدعوم من/);
    const bullets = (id: string, l: 'en' | 'ar') => PLANS.find(p => p.id === id)!.features[l];
    // basic: no cart recovery, no badge removal, no priority support in its limits => none promised
    expect(bullets('basic', 'en').join('|')).not.toMatch(/cart|badge|Priority/);
    expect(bullets('growth', 'en')).toContain('Win back shoppers who left their cart');
    expect(bullets('growth', 'en')).toContain('Remove the Ebda Store badge from your store');
    expect(bullets('business', 'en')).toContain('Priority support');
    expect(bullets('business', 'ar')).toContain('دعم بالأولوية');
    for (const p of PLANS) {
      expect(p.features.en).toHaveLength(4);
      expect(p.features.ar).toHaveLength(4);
      // every promise is backed by the plan's limits
      if (p.features.en.some(f => /cart/.test(f)))
        expect(p.limits.abandonedCartAutomation).toBe(true);
      if (p.features.en.some(f => /badge/.test(f))) expect(p.limits.brandingRemoval).toBe(true);
      if (p.features.en.some(f => /Priority/.test(f)))
        expect(p.limits.supportTier).toBe('priority');
    }
  });
  it('features: two hands-on hero features each with a visual, then a compact list of the rest', () => {
    for (const html of [ar, en]) {
      const f = html.match(/<section id="features".*?<\/section>/s)![0];
      expect(f.match(/class="fx-card"/g)).toHaveLength(2);
      for (const k of ['editor', 'orders']) expect(f).toContain(`data-feature="${k}"`);
      expect(f).not.toContain('data-feature="ai"');
      expect(f.match(/class="fx-visual[^"]*" role="img" aria-label="[^"]+"/g)).toHaveLength(2);
      expect(f.match(/<ul class="feature-list">.*?<\/ul>/s)![0].match(/<li>/g)).toHaveLength(3);
      expect(f).not.toMatch(/<svg[^>]*class="[^"]*illustration/);
    }
  });
  it('shows WhatsApp as a button only in the header, FAQ and close: wa.me link, icon + label, no number written (MKT-11)', () => {
    for (const html of [ar, en]) {
      const header = html.match(/<header class="site-header".*?<\/header>/s)![0];
      const faq = html.match(/<section id="faq".*?<\/section>/s)![0];
      const close = html.match(/<section id="start".*?<\/section>/s)![0];
      for (const part of [header, faq, close]) {
        expect(part).toContain('href="https://wa.me/201514191411"');
        expect(part).toMatch(/<a href="https:\/\/wa\.me\/201514191411"[^>]*aria-label="[^"]+"/);
        expect(part).toContain('class="wa-icon"');
        expect(part).toMatch(/class="wa-label">(واتساب|WhatsApp)</);
        // the number is never rendered as text or inside an accessible name; only the wa.me href carries it
        const noHref = part.replace(/href="https:\/\/wa\.me\/201514191411"/g, '');
        expect(noHref).not.toMatch(/201514191411|151 419 1411|wa-num/);
      }
    }
    expect(ar).toContain('>واتساب<');
    expect(en).toContain('>WhatsApp<');
  });
  it('shows the looks picker: 5 template tabs, Qamar rendered, every phone labelled illustrative', () => {
    for (const [html, badge] of [
      [ar, 'صور توضيحية'],
      [en, 'Illustrative'],
    ] as const) {
      const s = html.match(/<section id="looks".*?<section id="model3d"/s)![0];
      expect(s.match(/role="tab"/g)).toHaveLength(5);
      expect(s).toContain('role="tablist"');
      expect(s).toMatch(
        /aria-selected="true"[^>]*id="looks-tab-qamar"|id="looks-tab-qamar"[^>]*aria-selected="true"/
      );
      expect(s.match(new RegExp(`<span class="look-badge">${badge}</span>`, 'g'))).toHaveLength(3);
      for (const l of ['a', 'b', 'c']) expect(s).toContain(`id="ph-qamar-${l}"`);
      // photos are files, never inlined
      expect(s).toContain('/looks/img/qa__hero.webp');
      expect(s).not.toContain('base64');
      // one "open the live store" link per look (Qamar is the rendered tab), and #demo kept as an anchor here
      for (const l of ['atelier', 'lookbook', 'vitrine'])
        expect(s).toContain(`href="https://storedemo.ebda.app/?look=qamar.${l}"`);
      expect(s).toContain('id="demo"');
    }
    expect(en).toContain('Every template ships in Arabic and English');
    // the looks fetch is extensionless: Workers Static Assets 307-redirect /looks/x.html to /looks/x
    const showcase = readFileSync(
      path.resolve(__dirname, '../../apps/marketing/src/components/LooksShowcase.tsx'),
      'utf8'
    );
    expect(showcase).toContain('fetch(`/looks/${id}`)');
    expect(showcase).not.toMatch(/fetch\([^)]*\.html/);
  });
  it('ships every template fragment and photo it references', () => {
    for (const t of ['qamar', 'souq', 'jasmine', 'lamma', 'dahab']) {
      const frag = pub(`looks/${t}.html`);
      expect(frag.split('<!--look-->')).toHaveLength(4);
      expect(frag).not.toContain('base64');
      for (const m of frag.matchAll(/\/looks\/img\/([\w-]+\.webp)/g))
        expect(
          existsSync(path.resolve(__dirname, '../../apps/marketing/public/looks/img', m[1]))
        ).toBe(true);
    }
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
    expect(org.alternateName).toBe('ابدأ ستوديو للذكاء الاصطناعي');
    expect(org.url).toBe('https://ebda.app');
    expect(org).not.toHaveProperty('parentOrganization');
    expect(JSON.stringify(org)).not.toMatch(/whisky/i);
  });
  it('the about page carries the company line, the story and both contact addresses', () => {
    for (const l of ['ar', 'en'] as const) {
      const html = renderToStaticMarkup(<AboutPage locale={l} />);
      expect(html).toContain(
        l === 'en'
          ? 'owned and operated by Ebda AI Studio'
          : 'مملوكة لابدأ ستوديو للذكاء الاصطناعي'
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
    const a = pageMetadata('ar', 'store').alternates!;
    expect(a.languages).toEqual({ ar: '/store', en: '/en/store', 'x-default': '/store' });
    expect(a.canonical).toBe('/store');
    const h = pageMetadata('ar', '', 'x', 'y', 'studio').alternates!;
    expect(h.languages).toEqual({ ar: '/', en: '/en', 'x-default': '/' });
    expect(h.canonical).toBe('/');
    expect(pageMetadata('en', 'privacy').alternates!.languages).toMatchObject({
      ar: '/privacy',
      en: '/en/privacy',
    });
  });
  it('JSON-LD has Organization, WebSite, SoftwareApplication, FAQPage and no ratings', () => {
    const g = jsonLd('en')['@graph'];
    expect(g.map(n => n['@type'])).toEqual([
      'Organization',
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
    for (const [locale, word] of [
      ['ar', 'الإصدار'],
      ['en', 'Version'],
    ] as const) {
      for (const page of LEGAL_SLUGS) {
        const cur = currentLegalVersion(LEGAL_POLICIES, DOC_OF[page]);
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />);
        expect(html).toContain(`${word} ${cur.version}`);
        // the WhatsApp button's wa.me href is the only long number on the page, and it is not a registration number
        const withoutPhone = html.replace(/201514191411/g, '');
        expect(withoutPhone).not.toMatch(/\b\d{5,}\b/);
      }
    }
  });
  it('every legal page (both locales) is versioned, names the contact, and has no placeholders', () => {
    for (const locale of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS) {
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />);
        expect(html).toContain('ahlan@ebda.app');
        expect(html).not.toMatch(/\[[^\]]*\]/);
        expect(html.match(/<section/g)!.length).toBeGreaterThanOrEqual(5);
      }
  });
  it("each legal page's date and version equal LEGAL_POLICIES, in ar and en (Ruling LEGAL-4)", () => {
    for (const locale of ['ar', 'en'] as const)
      for (const page of LEGAL_SLUGS) {
        const cur = currentLegalVersion(LEGAL_POLICIES, DOC_OF[page]);
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={page} />).toLowerCase();
        expect(html).toContain(
          `<time datetime="${cur.publishedAt}">${formatLegalDate(cur.publishedAt, locale).toLowerCase()}</time>`
        );
      }
  });
  it('the legal copy holds no date or version literal, and the registry titles/slugs match the pages', () => {
    for (const locale of ['ar', 'en'] as const) {
      const lp = COPY[locale].legalPages;
      expect(Object.keys(lp.updated).sort()).toEqual(['label', 'versionLabel']);
      expect(lp.notice).not.toMatch(/\d/);
      for (const page of LEGAL_SLUGS) {
        const key = DOC_OF[page];
        expect(LEGAL_DOC_TITLE[key][locale]).toBe(lp[key].title);
        expect(LEGAL_DOC_SLUG[key]).toBe(page);
      }
    }
  });
  it('footer.legalVersion states the newest legal update date from LEGAL_POLICIES, no version (A3, M5)', () => {
    // Independent of content.ts: every document's current publishedAt, sorted, newest last.
    const latest = (Object.keys(LEGAL_POLICIES) as LegalDocKey[])
      .map(k => currentLegalVersion(LEGAL_POLICIES, k).publishedAt)
      .sort()
      .at(-1)!;
    for (const locale of ['ar', 'en'] as const) {
      const t = COPY[locale].footer.legalVersion;
      expect(t).toContain(formatLegalDate(latest, locale));
      expect(t).not.toMatch(/version|الإصدار|\b\d+\.\d+\b/i);
      expect(t).not.toMatch(/[٠-٩]/);
    }
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/marketing/src/lib/content.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/legalVersion:\s*['"`][^'"`]*\d/);
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
    const F = 'For' + 'ce';
    const bad = new RegExp(
      `${F} AI|${F}AI|${F} Website Builder|${F}-ai|\\b${'FW' + 'B'}\\b|\\b${F}\\b`,
      'i'
    );
    const all = [ar, en, pub('llms.txt'), pub('.well-known/security.txt'), pub('og.svg')];
    for (const p of LEGAL_SLUGS)
      for (const l of ['ar', 'en'] as const)
        all.push(renderToStaticMarkup(<LegalPage locale={l} page={p} />));
    for (const s of all) expect(s).not.toMatch(bad);
  });
});
