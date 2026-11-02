// @vitest-environment jsdom
/**
 * Phase B2 Task 2 (Ruling B2-1): the Souq search-first header. `prominent` = one labelled search
 * field on every viewport (under the logo row on a phone, in the centre column from md), `icon`
 * = the skin's own icon search. Targets are 44px, one banner, named navs, opaque focus ring.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({
  store: {
    id: 'store-s',
    name: 'Souq Demo',
    template: 'souq',
    look: 'souq.catalogue',
    theme: {},
  } as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: ctx.store.name }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.language,
      direction: ctx.language === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.language === 'ar',
      setLanguage: () => {},
      t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], bundles: [], itemCount: 0, total: 0 }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: SouqHeader } = await import('../../apps/web/src/templates/souq/Header');

const branding = { name: 'Souq Demo', nameAr: 'سوق التجربة', logo: null };
const nav = [
  { href: '/products', label: 'Products', labelAr: 'المنتجات' },
  { href: '/about', label: 'About', labelAr: 'عنّا' },
];
function setLook(
  look: string | null,
  lang: 'en' | 'ar' = 'ar',
  theme: Record<string, unknown> = {}
) {
  ctx.store = { ...ctx.store, template: 'souq', look, theme };
  ctx.language = lang;
}
afterEach(cleanup);

describe('souq header: search-first (prominent)', () => {
  it('Catalogue renders ONE labelled search field that submits to /search?q=', () => {
    setLook('souq.catalogue');
    const { container } = render(<SouqHeader branding={branding} navigation={nav} />);
    const forms = container.querySelectorAll('form[role="search"]');
    expect(forms).toHaveLength(1);
    expect(container.querySelectorAll('input[type="search"]')).toHaveLength(1);
    const form = forms[0] as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/search');
    expect(form.getAttribute('method')).toBe('get');
    const input = form.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input.name).toBe('q');
    expect(input.getAttribute('enterkeyhint')).toBe('search');
    // a real <label> bound to the field, in the page language
    const label = form.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toBe('دوّر على منتج أو ماركة');
    expect(input.placeholder).toBe('دوّر على منتج أو ماركة');
  });
  it('is under the logo row on a phone and in the centre column from md (one element, two placements)', () => {
    setLook('souq.catalogue');
    const { container } = render(<SouqHeader branding={branding} navigation={nav} />);
    const cls = container.querySelector('form[role="search"]')!.getAttribute('class')!;
    expect(cls).toMatch(/\bcol-span-2\b/);
    expect(cls).toMatch(/\brow-start-2\b/);
    expect(cls).toMatch(/\bmd:col-start-2\b/);
    expect(cls).toMatch(/\bmd:row-start-1\b/);
    // the old hidden mobile row and the desktop expander are not rendered next to it
    expect(container.querySelector('[data-zone="mobile-search"]')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(1);
  });
  it('English label and a non-empty query submits through onSearch, an empty one does not', () => {
    setLook('souq.catalogue', 'en');
    const onSearch = vi.fn();
    const { container } = render(
      <SouqHeader branding={branding} navigation={nav} onSearch={onSearch} />
    );
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(container.querySelector('label')?.textContent).toBe('Search for a product or brand');
    const form = container.querySelector('form[role="search"]')!;
    fireEvent.submit(form);
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  iphone 15 ' } });
    fireEvent.submit(form);
    expect(onSearch).toHaveBeenCalledWith('iphone 15');
  });
  it('the clear button shows only with text, clears it, and returns focus to the field', () => {
    setLook('souq.catalogue', 'ar');
    const { container } = render(<SouqHeader branding={branding} />);
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(container.querySelector('button[aria-label="مسح البحث"]')).toBeNull();
    fireEvent.change(input, { target: { value: 'ثلاجة' } });
    const clear = container.querySelector('button[aria-label="مسح البحث"]') as HTMLButtonElement;
    expect(clear).not.toBeNull();
    fireEvent.click(clear);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('button[aria-label="مسح البحث"]')).toBeNull();
  });
  it('removes the native WebKit search cancel button (no unthemed native control)', () => {
    setLook('souq.catalogue');
    const { container } = render(<SouqHeader branding={branding} />);
    expect(container.querySelector('input[type="search"]')!.getAttribute('class')).toContain(
      '[&::-webkit-search-cancel-button]:appearance-none'
    );
  });
});

describe('souq header: icon search (Showroom)', () => {
  it('keeps the skin icon search and renders no prominent field', () => {
    setLook('souq.showroom', 'en');
    const { container } = render(<SouqHeader branding={branding} navigation={nav} />);
    expect(container.querySelector('form[role="search"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Search"]')).not.toBeNull();
    expect(container.querySelector('[data-zone="mobile-search"]')).not.toBeNull();
  });
  it('an unknown or absent look falls back to the icon search and never throws', () => {
    setLook('souq.gone');
    expect(
      render(<SouqHeader branding={branding} />).container.querySelector('form[role="search"]')
    ).toBeNull();
    cleanup();
    setLook(null);
    expect(
      render(<SouqHeader branding={branding} />).container.querySelector('form[role="search"]')
    ).toBeNull();
  });
});

describe('souq header: targets, landmarks, long names, focus', () => {
  for (const look of ['souq.catalogue', 'souq.night', 'souq.showroom']) {
    it(`${look}: every control is a >= 44px target (with text in the field so the clear button counts)`, () => {
      setLook(look, 'ar');
      const { container } = render(<SouqHeader branding={branding} navigation={nav} isLoggedIn />);
      const input = container.querySelector('input[type="search"]') as HTMLInputElement | null;
      if (input) fireEvent.change(input, { target: { value: 'x' } });
      expect(smallTargets(container, 44)).toEqual([]);
    });
  }
  it('one banner, every nav named', () => {
    setLook('souq.catalogue');
    const { container } = render(<SouqHeader branding={branding} navigation={nav} />);
    expect(container.querySelectorAll('header, [role="banner"]')).toHaveLength(1);
    for (const n of Array.from(container.querySelectorAll('nav')))
      expect(n.getAttribute('aria-label'), n.outerHTML.slice(0, 60)).toBeTruthy();
  });
  it('a 30+ character store name wraps to two lines in a capped slot and cannot reach the actions', () => {
    setLook('souq.catalogue', 'ar');
    const longName = 'متجر سوق للإلكترونيات والأجهزة المنزلية الكبيرة جدا';
    const { container } = render(
      <SouqHeader branding={{ ...branding, nameAr: longName }} navigation={nav} />
    );
    const row = container.querySelector('header > div > div')!;
    expect(row.getAttribute('class')).toContain('grid-cols-[minmax(0,1fr)_auto]');
    expect(row.getAttribute('class')).toContain('md:grid-cols-[auto_minmax(0,1fr)_auto]');
    const logo = container.querySelector('a[href="/"]')!;
    expect(logo.getAttribute('class')).toContain('max-w-[calc(100%-13rem)]');
    expect(logo.getAttribute('class')).toContain('md:max-w-[16rem]');
    const mark = container.querySelector('[data-zone="storeName"]')!;
    // STOP-2: wraps (2 lines, balanced) instead of ending in an ellipsis; the title keeps the full name.
    expect(mark.firstElementChild!.getAttribute('class')).toMatch(/\bline-clamp-2\b/);
    expect(mark.firstElementChild!.getAttribute('class')).not.toMatch(/\btruncate\b/);
    expect(mark.getAttribute('title')).toBe(longName);
  });
  it('the wordmark is the sized, untracked display one; nav links are 14px untracked', () => {
    setLook('souq.catalogue', 'en');
    const { container } = render(<SouqHeader branding={branding} navigation={nav} />);
    // G1 (template-match): the no-logo wordmark is the look's lockup, sized from the mock-up (>= 28px) and untracked.
    const lockup = container.querySelector('[data-zone="storeName"]')!;
    expect(lockup.getAttribute('data-lockup')).toBeTruthy();
    const size = Number.parseInt((lockup.firstElementChild as HTMLElement).style.fontSize, 10);
    expect(size).toBeGreaterThanOrEqual(28);
    expect(lockup.outerHTML).not.toMatch(/ui-caps-toggle|tracking-\[/);
    expect(container.querySelector('a[href="/products"]')!.getAttribute('class')).toContain(
      'text-sm'
    );
  });
  it('the field draws an opaque focus ring (no alpha ring)', () => {
    setLook('souq.catalogue');
    const { container } = render(<SouqHeader branding={branding} />);
    const cls = container.querySelector('input[type="search"]')!.getAttribute('class')!;
    expect(cls).toMatch(/\bfocus-visible:ring-2\b/);
    expect(cls).toMatch(/\bfocus-visible:ring-primary\b(?!\/)/);
    expect(cls).not.toMatch(/ring-[a-z-]+\/\d+/);
  });
});
