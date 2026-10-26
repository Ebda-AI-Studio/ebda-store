/**
 * The Ebda WhatsApp product page (/whatsapp, /en/whatsapp): the product named in full, the two calls to action,
 * the facts that must be on it, no invented price (package prices are not decided in code), and a JSON-LD graph that
 * carries no Offer. Also: the Products menu lists the two live products in both locales.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WhatsAppPage } from '../../apps/marketing/src/components/WhatsAppPage';
import { Header } from '../../apps/marketing/src/components/Header';
import { whatsappJsonLd } from '../../apps/marketing/src/lib/seo';
import { WHATSAPP_PAGE } from '../../apps/marketing/src/lib/whatsapp-page';
import { LOCALES } from '../../apps/marketing/src/lib/site';

describe('Ebda WhatsApp page', () => {
  for (const l of LOCALES) {
    const html = renderToStaticMarkup(<WhatsAppPage locale={l} />);
    const name = l === 'ar' ? 'ابدأ واتساب' : 'Ebda WhatsApp';
    it(`${l}: names the product, links sign-up and the app, states the facts, invents no price`, () => {
      expect(html).toContain(name);
      expect(html).toContain('href="https://store.ebda.app/signup"');
      expect(html).toContain('href="https://wa.ebda.app"');
      expect(html).toContain('accounts.ebda.app');
      expect(html).toContain('0%'); // no margin on Meta's fees at the moment (WA-MARGIN-1)
      expect(html).not.toMatch(/\bEGP\s?\d|ج\.م/); // no package price is published
      expect(html).not.toMatch(/orange|#ff6e01/i);
    });
    it(`${l}: the JSON-LD names the product, carries the FAQ and no Offer`, () => {
      const ld = JSON.stringify(whatsappJsonLd(l, WHATSAPP_PAGE[l].faq));
      expect(ld).toContain('SoftwareApplication');
      expect(ld).toContain('FAQPage');
      expect(ld).not.toContain('Offer');
    });
    it(`${l}: the header Products menu lists Ebda Store and Ebda WhatsApp`, () => {
      const h = renderToStaticMarkup(<Header locale={l} page="whatsapp" />);
      const menu = /<li class="nav-products">.*?<\/details>/s.exec(h)![0];
      expect(menu).toContain(l === 'ar' ? '<b>ابدأ ستور</b>' : '<b>Ebda Store</b>');
      expect(menu).toContain(`<b>${name}</b>`);
      expect(menu).toContain(`href="${l === 'ar' ? '' : '/en'}/whatsapp"`);
    });
  }
});
