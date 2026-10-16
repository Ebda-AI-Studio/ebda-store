/**
 * SUBDOMAIN-404-1: a host that is not a live store gets one Ebda-branded 404
 * (AR default, EN by locale), with the ebda.app CTA, WhatsApp only when a
 * number exists, and the demo-store link only behind SHOW_DEMO_STORE_LINK.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const languageState = { language: 'ar' as 'en' | 'ar' };
vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: languageState.language,
    isRtl: languageState.language === 'ar',
    t: (en: string, ar?: string) => (languageState.language === 'ar' ? (ar ?? en) : en),
  }),
}));

const { UnknownHostNotFound } = await import('@web/components/UnknownHostNotFound');
const { notFoundKind, unknownHostLinks } = await import('@web/lib/unknown-store-page');

const render = (lang: 'en' | 'ar', links = unknownHostLinks({})) => {
  languageState.language = lang;
  return renderToStaticMarkup(<UnknownHostNotFound links={links} />);
};

describe('UnknownHostNotFound', () => {
  it('renders Arabic copy and the ebda.app CTA', () => {
    const html = render('ar');
    expect(html).toContain('المتجر ده مش موجود أو لسه ما فتحش');
    expect(html).toContain('أنشئ متجرك على إبدأ');
    expect(html).toContain('href="https://ebda.app"');
  });

  it('renders English copy by locale', () => {
    const html = render('en');
    expect(html).toContain('This store doesn’t exist or hasn’t opened yet');
    expect(html).toContain('Create your store on Ebda');
  });

  it('uses Ebda brand colours and no Force orange', () => {
    const html = render('ar');
    expect(html.toLowerCase()).toContain('#b08d57');
    expect(html.toLowerCase()).not.toMatch(/#ff6e01|#c04e00/);
  });

  it('shows the WhatsApp button with a real wa.me link when the platform has a number', () => {
    const html = render('ar');
    expect(html).toMatch(/href="https:\/\/wa\.me\/\d+"/);
  });

  it('omits WhatsApp when no number is available, never an empty wa.me link', () => {
    const html = render('ar', { ...unknownHostLinks({}), whatsappHref: null });
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('تواصل معنا عبر واتساب');
  });

  it('hides the demo store link by default and shows it only for SHOW_DEMO_STORE_LINK=true', () => {
    expect(unknownHostLinks({}).demoStoreHref).toBeNull();
    expect(unknownHostLinks({ SHOW_DEMO_STORE_LINK: '1' }).demoStoreHref).toBeNull();
    expect(render('ar')).not.toContain('storedemo');
    const on = unknownHostLinks({ SHOW_DEMO_STORE_LINK: 'true' });
    expect(on.demoStoreHref).toBe('https://storedemo.ebda.app');
    const html = render('ar', on);
    expect(html).toContain('href="https://storedemo.ebda.app"');
    expect(html).toContain('جرّب المتجر التجريبي');
  });
});

describe('notFoundKind', () => {
  it('a resolved store keeps its own 404', () => {
    expect(notFoundKind('nile.ebda.app', { id: 'store_1' })).toBe('store');
  });
  it('an unknown/inactive store host (demo sentinel) gets the generic page', () => {
    expect(notFoundKind('demostore.ebda.app', { id: 'demo' })).toBe('unknown-host');
  });
  it('a platform host (no store domain) gets the generic page', () => {
    expect(notFoundKind(null, { id: 'demo' })).toBe('unknown-host');
    expect(notFoundKind('', { id: 'store_1' })).toBe('unknown-host');
  });
});
