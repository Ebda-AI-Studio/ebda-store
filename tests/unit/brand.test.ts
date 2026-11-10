import { describe, it, expect } from 'vitest';
import {
  BRAND,
  brandFrom,
  brandName,
  productName,
  brandUrl,
  isBrandHost,
  poweredByBrand,
  storeHost,
  storeOrigin,
  whatsappDisplay,
  whatsappUrl,
} from '../../packages/shared/src/brand';

describe('BRAND', () => {
  it('carries the Ebda identity from the brief', () => {
    expect(BRAND.name).toBe('Ebda AI Studio');
    expect(BRAND.nameAr).toBe('ابدأ ستوديو للذكاء الاصطناعي');
    expect(BRAND.company).toEqual({
      legalNameAr: 'ابدأ ستوديو لتكنولوجيا المعلومات',
      legalNameEn: 'Ebda Studio',
      shortNameAr: 'ابدأ ستوديو للذكاء الاصطناعي',
      shortNameEn: 'Ebda AI Studio',
      foundedOn: '2026-09-11',
      url: 'https://ebda.app',
    });
    expect(BRAND.colors).toEqual({ night: '#0A0B0C', gold: '#B08D57', lift: '#CBA873' });
    expect(BRAND.fonts.sans).toBe('Geist');
    expect(BRAND.fonts.arabic).toBe('IBM Plex Sans Arabic');
    expect(BRAND.supportEmail).toBe('ahlan@ebda.app');
    expect(BRAND.noReplyEmail).toBe('no-reply@ebda.app');
  });

  it('carries the public WhatsApp line once, with a wa.me link and a readable form', () => {
    expect(BRAND.contact.whatsapp).toBe('+201514191411');
    expect(whatsappUrl()).toBe('https://wa.me/201514191411');
    expect(whatsappUrl('أهلاً ستور')).toBe(
      `https://wa.me/201514191411?text=${encodeURIComponent('أهلاً ستور')}`
    );
    expect(whatsappDisplay()).toBe('+20 151 419 1411');
  });

  it('store.ebda.app is the merchant app; admin.ebda.app is retired (HOST-STORE-1)', () => {
    expect(BRAND.domains.storeApp).toBe('store.ebda.app');
    expect(Object.values(BRAND.domains)).not.toContain('admin.ebda.app');
    // Stores still live on <slug>.ebda.app; `store` is a reserved slug, never a store.
    expect(BRAND.domains.storeSuffix).toBe('.ebda.app');
  });
});

describe('brand helpers', () => {
  it('builds store hosts and origins from a slug', () => {
    expect(storeHost(' Amelia-Aurum ')).toBe('amelia-aurum.ebda.app');
    expect(storeOrigin('amelia-aurum')).toBe('https://amelia-aurum.ebda.app');
  });

  it('recognises brand hosts only', () => {
    expect(isBrandHost('ebda.app')).toBe(true);
    expect(isBrandHost('Shop.EBDA.app:443')).toBe(true);
    expect(isBrandHost('notebda.app')).toBe(false);
    expect(isBrandHost('ebda.app.evil.com')).toBe(false);
    expect(isBrandHost(undefined)).toBe(false);
  });

  it('localises the name, sender and footer', () => {
    expect(brandName('ar-EG')).toBe('ابدأ ستوديو للذكاء الاصطناعي');
    expect(brandName('en')).toBe('Ebda AI Studio');
    expect(productName('en')).toBe('Ebda Store');
    expect(productName('ar-EG')).toBe('ابدأ ستور');
    expect(brandFrom()).toBe('Ebda Store <no-reply@ebda.app>');
    expect(poweredByBrand()).toBe('Powered by Ebda Store');
    expect(poweredByBrand('ar')).toBe('مدعوم من ابدأ ستور');
    expect(brandUrl(BRAND.domains.storeApp)).toBe('https://store.ebda.app');
  });
});

describe('sender display name (BRAND-NAME-1)', () => {
  it('store mail is Ebda Store, account mail is Ebda AI Studio, never the bare "Ebda"', () => {
    expect(brandFrom()).toBe('Ebda Store <no-reply@ebda.app>');
    expect(brandFrom(BRAND.name)).toBe('Ebda AI Studio <no-reply@ebda.app>');
    expect(() => brandFrom('Ebda')).toThrow(/bare/);
    expect(() => brandFrom(' ebda ')).toThrow(/bare/);
  });
});

describe('product name (PRODUCT-NAME-1)', () => {
  it('names the product Ebda Store while the company is Ebda AI Studio', () => {
    expect(BRAND.product).toEqual({ nameEn: 'Ebda Store', nameAr: 'ابدأ ستور' });
    expect(BRAND.name).toBe('Ebda AI Studio');
    expect(BRAND.nameAr).toBe('ابدأ ستوديو للذكاء الاصطناعي');
  });

  it('derives the sender display name, JSON-LD and legal Service name from BRAND.product', async () => {
    expect(brandFrom()).toBe(`${BRAND.product.nameEn} <${BRAND.noReplyEmail}>`);
    const { jsonLd } = await import('../../apps/marketing/src/lib/seo');
    const app = jsonLd('en')['@graph'].find(
      (n: { '@type': string }) => n['@type'] === 'SoftwareApplication'
    );
    expect(app).toMatchObject({ name: BRAND.product.nameEn, alternateName: BRAND.product.nameAr });
    const { LEGAL_EN } = await import('../../apps/marketing/src/lib/legal-en');
    const { LEGAL_AR } = await import('../../apps/marketing/src/lib/legal-ar');
    expect(LEGAL_EN.legal.sections[0].p[0]).toContain(
      `"${BRAND.product.nameEn}" («${BRAND.product.nameAr}»)`
    );
    expect(LEGAL_AR.legal.sections[0].p[0]).toContain(
      `«${BRAND.product.nameAr}» (${BRAND.product.nameEn})`
    );
  });

  it('reserves the product-family slugs', async () => {
    const { isReservedSlug } = await import('../../packages/shared/src/hosts/reserved-slugs');
    for (const s of [
      'store',
      'whatsapp',
      'crm',
      'erp',
      'hub',
      'id',
      'accounts',
      'invite',
      'quote',
    ]) {
      expect(isReservedSlug(s)).toBe(true);
    }
  });
});
