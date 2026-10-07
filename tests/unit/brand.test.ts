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
    expect(BRAND.company).toBe('Whisky 11');
    expect(BRAND.colors).toEqual({ night: '#0A0B0C', gold: '#B08D57', lift: '#CBA873' });
    expect(BRAND.fonts.sans).toBe('Geist');
    expect(BRAND.fonts.arabic).toBe('IBM Plex Sans Arabic');
    expect(BRAND.supportEmail).toBe('support@ebda.app');
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
    expect(brandFrom()).toBe('Ebda <no-reply@ebda.app>');
    expect(poweredByBrand()).toBe('Powered by Ebda');
    expect(poweredByBrand('ar')).toBe('مدعوم من ابدأ');
    expect(brandUrl(BRAND.domains.admin)).toBe('https://admin.ebda.app');
  });
});
