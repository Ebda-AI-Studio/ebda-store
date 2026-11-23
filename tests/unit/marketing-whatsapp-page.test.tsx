/**
 * The Ebda Chat product page (/whatsapp, /en/whatsapp): the product named in full, the two calls to action,
 * the facts that must be on it, and the package prices (WA-PRICE-1): the constant is pinned to the approved numbers, and
 * the rendered cards and the JSON-LD offers both equal the constant (never a second copy of a number). Also: the Products menu lists the two live products in both locales.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WhatsAppPage } from '../../apps/marketing/src/components/WhatsAppPage';
import { Header } from '../../apps/marketing/src/components/Header';
import { whatsappJsonLd } from '../../apps/marketing/src/lib/seo';
import { WHATSAPP_PAGE } from '../../apps/marketing/src/lib/whatsapp-page';
import { LOCALES } from '../../apps/marketing/src/lib/site';
import { egp } from '../../apps/marketing/src/lib/demo-stores';
import {
  WHATSAPP_MONTHLY_PACKAGES,
  WHATSAPP_PACKAGES,
  whatsappPackageName,
  whatsappYearlyOf,
  type WhatsAppBasePackageId,
} from '../../packages/shared/src/brand';

/** What renderToStaticMarkup does to text. */
const esc = (t: string) => t.replace(/'/g, '&#x27;');

describe('Ebda Chat page', () => {
  for (const l of LOCALES) {
    const html = renderToStaticMarkup(<WhatsAppPage locale={l} />);
    const name = l === 'ar' ? 'ابدأ شات' : 'Ebda Chat';
    it(`${l}: names the product, links the Chat app (no Store CTA, no infra host), states the facts, invents no price`, () => {
      expect(html).toContain(name);
      expect(html).toContain('href="https://wa.ebda.app"');
      expect(html).not.toContain('store.ebda.app');
      expect(html).not.toContain('accounts.ebda.app');
      expect(html).not.toMatch(/href="(\/en)?\/#(story|looks|faq)"/);
      expect(html).not.toMatch(
        /ابدأ ستور — منتج|Ebda Store — a product|ابدأ ستور منتج من|Ebda Store is a product/
      );
      expect(html).toContain('0%'); // no margin on Meta's fees at the moment (WA-MARGIN-1)
      expect(html).not.toMatch(/orange|#ff6e01/i);
    });
    it(`${l}: the four cards show the constant's prices (monthly and yearly) and AI credits`, () => {
      expect(html.match(/data-plan-cta="/g)).toHaveLength(4);
      // there is no free plan: the store-included card names what it is included with and shows no price figure
      const included = html.slice(
        html.indexOf('data-plan="store-included"'),
        html.indexOf('data-plan="starter"')
      );
      expect(included).toContain(esc(WHATSAPP_PAGE[l].pricing.includedLabel));
      expect(included).not.toMatch(/EGP\s?0\b|\b0 ج\.م|Free|مجاني|ببلاش/);
      for (const p of WHATSAPP_MONTHLY_PACKAGES.filter(x => x.priceMinor > 0)) {
        expect(html).toContain(egp(l, p.priceMinor / 100));
        expect(html).toContain(
          egp(l, whatsappYearlyOf(p.id as WhatsAppBasePackageId).priceMinor / 100)
        );
        expect(html).toContain(WHATSAPP_PAGE[l].pricing.aiCredits(p.features.ai_credits));
        expect(html).toContain(WHATSAPP_PAGE[l].pricing.members(p.features.members));
      }
      expect(html).toContain(esc(WHATSAPP_PAGE[l].pricing.metaNote));
    });
    it(`${l}: the JSON-LD carries the FAQ and one Offer per priced package id (no 0-price offer)`, () => {
      const g = whatsappJsonLd(l, WHATSAPP_PAGE[l].faq)['@graph'];
      expect(JSON.stringify(g)).toContain('FAQPage');
      const app = g.find(n => n['@type'] === 'SoftwareApplication') as {
        offers: { sku: string; price: string; priceSpecification: { billingDuration: string } }[];
      };
      const priced = WHATSAPP_PACKAGES.filter(p => p.priceMinor > 0);
      expect(app.offers.map(o => o.sku)).toEqual(priced.map(p => p.id));
      expect(app.offers.map(o => o.price)).not.toContain('0.00');
      for (const p of priced) {
        const o = app.offers.find(x => x.sku === p.id)!;
        expect(o.price).toBe((p.priceMinor / 100).toFixed(2));
        expect(o.priceSpecification.billingDuration).toBe(p.periodMonths === 12 ? 'P1Y' : 'P1M');
      }
    });
    it(`${l}: the hero and FAQ carry the WA-COPY-1 wording`, () => {
      const p = WHATSAPP_PAGE[l];
      expect(p.h1).toBe(
        l === 'ar'
          ? 'ابدأ شات — بيع ورد على عملائك على واتساب'
          : 'Ebda Chat — sell and support your customers on WhatsApp'
      );
      expect(p.lead).toContain(
        l === 'ar'
          ? 'أكّد الطلبات وابعت الحملات لعملائك على واتساب من مكان واحد'
          : 'Confirm orders and send campaigns to your customers on WhatsApp, all in one place'
      );
      expect(p.lead).toContain(
        l === 'ar'
          ? 'بيشتغل على منصة واتساب للأعمال الرسمية من Meta'
          : 'Works with the WhatsApp Business Platform'
      );
      expect(p.faq[p.faq.length - 2].q).toBe(
        l === 'ar' ? 'هل ابدأ شات تبع واتساب؟' : 'Is Ebda Chat part of WhatsApp?'
      );
    });
    it(`${l}: the header Products menu lists Ebda Store and Ebda Chat`, () => {
      const h = renderToStaticMarkup(<Header locale={l} page="whatsapp" />);
      const menu = /<li class="nav-products">.*?<\/details>/s.exec(h)![0];
      expect(menu).toContain(l === 'ar' ? '<b>ابدأ ستور</b>' : '<b>Ebda Store</b>');
      expect(menu).toContain(`<b>${name}</b>`);
      expect(menu).toContain(`href="${l === 'ar' ? '' : '/en'}/whatsapp"`);
    });
  }
});

describe('WHATSAPP_PACKAGES (Ruling WA-PRICE-1 / WA-PRICE-1a)', () => {
  it('pins the approved ids, periods, prices (EGP piastres), seats and AI credits', () => {
    expect(
      WHATSAPP_PACKAGES.map(p => [
        p.id,
        p.periodMonths,
        p.priceMinor,
        p.features.members,
        p.features.ai_credits,
      ])
    ).toEqual([
      ['store-included', 1, 0, 2, 100],
      ['starter', 1, 69000, 2, 300],
      ['growth', 1, 149000, 5, 1500],
      ['pro', 1, 349000, 15, 5000],
      ['starter-yearly', 12, 621000, 2, 300],
      ['growth-yearly', 12, 1341000, 5, 1500],
      ['pro-yearly', 12, 3141000, 15, 5000],
    ]);
  });
  it('a yearly package is its monthly twin at 9x with the same features', () => {
    for (const id of ['starter', 'growth', 'pro'] as const) {
      const m = WHATSAPP_PACKAGES.find(p => p.id === id)!;
      const y = WHATSAPP_PACKAGES.find(p => p.id === `${id}-yearly`)!;
      expect(y.priceMinor).toBe(m.priceMinor * 9);
      expect(y.features).toEqual(m.features);
    }
  });
  it('pins the switches and the entitlement keys', () => {
    const on = (id: string) =>
      Object.entries(WHATSAPP_PACKAGES.find(p => p.id === id)!.features)
        .filter(([, v]) => v === true)
        .map(([k]) => k);
    const base = ['shared_inbox', 'order_confirmations', 'templates'];
    expect(on('store-included')).toEqual(base);
    expect(on('starter')).toEqual(base);
    expect(on('growth')).toEqual([...base, 'campaigns', 'order_in_chat']);
    expect(on('pro')).toEqual([...base, 'campaigns', 'order_in_chat', 'api', 'priority_support']);
    expect(Object.keys(WHATSAPP_PACKAGES[0].features).sort()).toEqual(
      [
        'members',
        'shared_inbox',
        'order_confirmations',
        'templates',
        'campaigns',
        'order_in_chat',
        'api',
        'priority_support',
        'ai_credits',
      ].sort()
    );
  });
});

/** Ahmad 2026-11-19: Chat packages are named BY SIZE (monthly AI replies); Starter / Growth / Pro collide with the Store's plan names. Mirrors ebda-whatsapp test/package-names.test.ts. */
describe('Chat package names are by size', () => {
  it('pins the exact names both products show (ids and prices unchanged)', () => {
    expect(whatsappPackageName('starter', 'en')).toBe('Chat 300 AI replies');
    expect(whatsappPackageName('growth', 'en')).toBe('Chat 1,500 AI replies');
    expect(whatsappPackageName('pro-yearly', 'en')).toBe('Chat 5,000 AI replies (yearly)');
    expect(whatsappPackageName('starter', 'ar')).toBe('شات 300 رد ذكي');
    expect(whatsappPackageName('growth', 'ar')).toBe('شات 1500 رد ذكي');
    expect(whatsappPackageName('pro-yearly', 'ar')).toBe('شات 5000 رد ذكي سنوي');
    expect(whatsappPackageName('growth', 'ar')).not.toMatch(/[٠-٩]/); // Western digits (DIGITS-1)
  });
  for (const l of LOCALES) {
    it(`${l}: the page shows the size names on the cards and the choice, and no tier name`, () => {
      const html = renderToStaticMarkup(<WhatsAppPage locale={l} />);
      for (const id of ['starter', 'growth', 'pro'] as const)
        expect(html).toContain(esc(whatsappPackageName(id, l)));
      expect(html).not.toMatch(/\b(Starter|Growth|Professional|Pro)\b/);
      expect(html).not.toMatch(/المبتدئة|الاحترافية/);
      const ld = JSON.stringify(whatsappJsonLd(l, WHATSAPP_PAGE[l].faq));
      expect(ld).not.toMatch(/\b(Starter|Growth|Professional|Pro)\b/);
      expect(ld).toContain(whatsappPackageName('growth', l));
    });
  }
});
