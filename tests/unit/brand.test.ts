import { describe, it, expect } from 'vitest';
import {
  BRAND,
  brandFrom,
  brandName,
  brandUrl,
  isBrandHost,
  poweredByBrand,
  storeHost,
  storeOrigin,
} from '../../packages/shared/src/brand';

describe('BRAND', () => {
  it('carries the Ebda identity from the brief', () => {
    expect(BRAND.name).toBe('Ebda');
    expect(BRAND.nameAr).toBe('ابدأ');
    expect(BRAND.company).toEqual({
      legalNameAr: 'ابدأ ستوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
      legalNameEn: 'Ebda AI Studio for Artificial Intelligence, Software and Digital Marketing',
      shortNameAr: 'ابدأ ستوديو',
      shortNameEn: 'Ebda AI Studio',
      url: 'https://ebda.app',
    });
    expect(BRAND.colors).toEqual({ night: '#0A0B0C', gold: '#B08D57', lift: '#CBA873' });
    expect(BRAND.fonts.sans).toBe('Geist');
    expect(BRAND.fonts.arabic).toBe('IBM Plex Sans Arabic');
    expect(BRAND.supportEmail).toBe('ahlan@ebda.app');
    expect(BRAND.noReplyEmail).toBe('no-reply@ebda.app');
  });

  it('has no store.ebda.app host (stores live on <slug>.ebda.app)', () => {
    expect(Object.values(BRAND.domains)).not.toContain('store.ebda.app');
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
    expect(brandName('ar-EG')).toBe('ابدأ');
    expect(brandName('en')).toBe('Ebda');
    expect(brandFrom()).toBe('Ebda Store <no-reply@ebda.app>');
    expect(poweredByBrand()).toBe('Powered by Ebda');
    expect(poweredByBrand('ar')).toBe('مدعوم من ابدأ');
    expect(brandUrl(BRAND.domains.admin)).toBe('https://admin.ebda.app');
  });
});

describe('product name (PRODUCT-NAME-1)', () => {
  it('names the product Ebda Store while the master brand stays Ebda', () => {
    expect(BRAND.product).toEqual({ nameEn: 'Ebda Store', nameAr: 'ابدأ ستور' });
    expect(BRAND.name).toBe('Ebda');
    expect(BRAND.nameAr).toBe('ابدأ');
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
    for (const s of ['store', 'whatsapp', 'crm', 'erp', 'hub', 'id', 'accounts']) {
      expect(isReservedSlug(s)).toBe(true);
    }
  });
});
