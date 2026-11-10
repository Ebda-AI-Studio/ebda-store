// @vitest-environment jsdom
/**
 * The demo showroom bar (Rulings B1-11, B1-12): template then look, built looks only; choosing
 * navigates to `?look=<id>` on the same path; while a preview is showing, a same-origin link click
 * carries the look to the next page; nothing is ever written (no fetch). Plus the checkout notice
 * that replaces the pay action on a demo store.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

const assign = vi.fn();
let pathname = '/products';
let search = '';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
let lang: 'en' | 'ar' = 'en';
vi.mock('../../contexts/LanguageContext', async importOriginal => ({
  translations: (await importOriginal<typeof import('../../contexts/LanguageContext')>())
    .translations,
  useLanguage: () => ({
    isRtl: lang === 'ar',
    language: lang,
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));

beforeAll(() => {
  // Same origin as jsdom's document base, so `a.href` resolves like it does in a browser.
  const base = new URL(document.baseURI);
  Object.defineProperty(window, 'location', {
    value: { assign, href: base.href, origin: base.origin },
    writable: true,
  });
});

import { DemoLookBar, DEMO_BAR_SELECT_CLASS } from './DemoLookBar';
import { LOOKS, getLook } from '@ebda/shared';
import { DemoCheckoutNotice } from './DemoCheckoutNotice';

afterEach(() => {
  cleanup();
  assign.mockReset();
  vi.unstubAllGlobals();
  pathname = '/products';
  search = '';
  lang = 'en';
});

// The three Qamar looks plus one Souq look, injected (the registry flips them in Task 10).
const builtIds = new Set(['qamar.atelier', 'qamar.lookbook', 'qamar.vitrine', 'souq.night']);
const isBuilt = (id: string) => builtIds.has(id);
const qamarOnly = (id: string) => id.startsWith('qamar.');

const templateSelect = (c: HTMLElement) =>
  c.querySelector('select[data-demo-template]') as HTMLSelectElement;
const lookSelect = (c: HTMLElement) =>
  c.querySelector('select[data-demo-look]') as HTMLSelectElement;
const values = (s: HTMLSelectElement) =>
  [...s.querySelectorAll('option')].map(o => o.getAttribute('value'));

describe('DemoLookBar: template, then look', () => {
  it('lists only templates with a built look, then that template’s built looks', () => {
    const { container } = render(<DemoLookBar activeLook="qamar.lookbook" isBuilt={isBuilt} />);
    expect(values(templateSelect(container))).toEqual(['qamar', 'souq']);
    expect(templateSelect(container).value).toBe('qamar');
    expect(values(lookSelect(container))).toEqual([
      'qamar.atelier',
      'qamar.lookbook',
      'qamar.vitrine',
    ]);
    expect(lookSelect(container).value).toBe('qamar.lookbook');
  });

  it('with the real registry it lists the Qamar, Souq, Jasmine, Lamma and Dahab templates (each has a demo host, B2-7, B3-8, B4-10, B5-10), Qamar looks for a Qamar look', () => {
    const { container } = render(
      <DemoLookBar activeLook="qamar.atelier" isBuilt={id => getLook(id)?.status === 'built'} />
    );
    expect(values(templateSelect(container))).toEqual([
      'qamar',
      'souq',
      'jasmine',
      'lamma',
      'dahab',
    ]);
    expect(values(lookSelect(container))).toEqual([
      'qamar.atelier',
      'qamar.lookbook',
      'qamar.vitrine',
    ]);
  });

  it('with only the Qamar looks built, Qamar is the one template listed', () => {
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={qamarOnly} />);
    expect(values(templateSelect(container))).toEqual(['qamar']);
    expect(values(lookSelect(container))).toEqual([
      'qamar.atelier',
      'qamar.lookbook',
      'qamar.vitrine',
    ]);
  });

  it('changing the template selects its first built look', () => {
    pathname = '/products/linen-shirt';
    const { container } = render(<DemoLookBar activeLook="qamar.vitrine" isBuilt={isBuilt} />);
    fireEvent.change(templateSelect(container), { target: { value: 'souq' } });
    expect(assign).toHaveBeenCalledWith('/products/linen-shirt?look=souq.night');
  });

  it("on a demo host, changing the template goes to that template's own demo store (B2-7)", () => {
    const loc = window.location as unknown as Record<string, unknown>;
    const saved = { host: loc.host, protocol: loc.protocol };
    loc.host = 'storedemo.ebda.app';
    loc.protocol = 'https:';
    try {
      const { container } = render(<DemoLookBar activeLook="qamar.vitrine" isBuilt={isBuilt} />);
      fireEvent.change(templateSelect(container), { target: { value: 'souq' } });
      // the other template's host, its first built look, the home path (its catalogue differs)
      expect(assign).toHaveBeenCalledWith('https://storedemo-souq.ebda.app/?look=souq.night');
      cleanup();
      assign.mockReset();
      loc.host = 'storedemo-souq.ebda.app';
      const back = render(<DemoLookBar activeLook="souq.night" isBuilt={isBuilt} />);
      fireEvent.change(templateSelect(back.container), { target: { value: 'qamar' } });
      expect(assign).toHaveBeenCalledWith('https://storedemo.ebda.app/?look=qamar.atelier');
    } finally {
      loc.host = saved.host;
      loc.protocol = saved.protocol;
    }
  });

  it('Phase B3: Jasmine is offered once it has a built look, and its host keeps the look (B3-8)', () => {
    const jasmineBuilt = (id: string) => isBuilt(id) || id.startsWith('jasmine.');
    const loc = window.location as unknown as Record<string, unknown>;
    const saved = { host: loc.host, protocol: loc.protocol };
    loc.host = 'storedemo.ebda.app';
    loc.protocol = 'https:';
    try {
      const { container } = render(
        <DemoLookBar activeLook="qamar.atelier" isBuilt={jasmineBuilt} />
      );
      expect(values(templateSelect(container))).toEqual(['qamar', 'souq', 'jasmine']);
      fireEvent.change(templateSelect(container), { target: { value: 'jasmine' } });
      // its own host and its first built look (registry order: Apothecary)
      expect(assign).toHaveBeenCalledWith(
        'https://storedemo-jasmine.ebda.app/?look=jasmine.apothecary'
      );
      cleanup();
      assign.mockReset();
      loc.host = 'storedemo-jasmine.ebda.app';
      search = 'look=jasmine.bloom';
      const on = render(<DemoLookBar activeLook="jasmine.bloom" isBuilt={jasmineBuilt} />);
      expect(templateSelect(on.container).value).toBe('jasmine');
      expect(values(lookSelect(on.container))).toEqual([
        'jasmine.apothecary',
        'jasmine.bloom',
        'jasmine.clinic',
      ]);
      fireEvent.change(lookSelect(on.container), { target: { value: 'jasmine.clinic' } });
      expect(assign).toHaveBeenCalledWith('/products?look=jasmine.clinic');
    } finally {
      loc.host = saved.host;
      loc.protocol = saved.protocol;
    }
  });

  it('Phase B4: Lamma is offered once it has a built look, and its host keeps the look (B4-10)', () => {
    const lammaBuilt = (id: string) => isBuilt(id) || id.startsWith('lamma.');
    const loc = window.location as unknown as Record<string, unknown>;
    const saved = { host: loc.host, protocol: loc.protocol };
    loc.host = 'storedemo.ebda.app';
    loc.protocol = 'https:';
    try {
      const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={lammaBuilt} />);
      expect(values(templateSelect(container))).toEqual(['qamar', 'souq', 'lamma']);
      fireEvent.change(templateSelect(container), { target: { value: 'lamma' } });
      // its own host and its first built look (registry order: Family table)
      expect(assign).toHaveBeenCalledWith('https://storedemo-lamma.ebda.app/?look=lamma.table');
      cleanup();
      assign.mockReset();
      loc.host = 'storedemo-lamma.ebda.app';
      search = 'look=lamma.market';
      const on = render(<DemoLookBar activeLook="lamma.market" isBuilt={lammaBuilt} />);
      expect(templateSelect(on.container).value).toBe('lamma');
      expect(values(lookSelect(on.container))).toEqual([
        'lamma.table',
        'lamma.notebook',
        'lamma.market',
      ]);
      fireEvent.change(lookSelect(on.container), { target: { value: 'lamma.notebook' } });
      expect(assign).toHaveBeenCalledWith('/products?look=lamma.notebook');
    } finally {
      loc.host = saved.host;
      loc.protocol = saved.protocol;
    }
  });

  it('Phase B5: Dahab is offered once it has a built look, and its host keeps the look (B5-10)', () => {
    const dahabBuilt = (id: string) => isBuilt(id) || id.startsWith('dahab.');
    const loc = window.location as unknown as Record<string, unknown>;
    const saved = { host: loc.host, protocol: loc.protocol };
    loc.host = 'storedemo.ebda.app';
    loc.protocol = 'https:';
    try {
      const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={dahabBuilt} />);
      expect(values(templateSelect(container))).toEqual(['qamar', 'souq', 'dahab']);
      fireEvent.change(templateSelect(container), { target: { value: 'dahab' } });
      // its own host and its first built look (registry order: Worn)
      expect(assign).toHaveBeenCalledWith('https://storedemo-dahab.ebda.app/?look=dahab.worn');
      cleanup();
      assign.mockReset();
      loc.host = 'storedemo-dahab.ebda.app';
      search = 'look=dahab.giftbox';
      const on = render(<DemoLookBar activeLook="dahab.giftbox" isBuilt={dahabBuilt} />);
      expect(templateSelect(on.container).value).toBe('dahab');
      expect(values(lookSelect(on.container))).toEqual([
        'dahab.worn',
        'dahab.workshop',
        'dahab.giftbox',
      ]);
      fireEvent.change(lookSelect(on.container), { target: { value: 'dahab.workshop' } });
      expect(assign).toHaveBeenCalledWith('/products?look=dahab.workshop');
    } finally {
      loc.host = saved.host;
      loc.protocol = saved.protocol;
    }
  });

  it('a template whose looks are all unbuilt is not offered (the bar lists built, demo-hosted templates only)', () => {
    const { container } = render(
      <DemoLookBar activeLook="qamar.atelier" isBuilt={id => id.startsWith('qamar.')} />
    );
    expect(values(templateSelect(container))).toEqual(['qamar']);
  });

  it('selecting a look navigates to ?look=<id> on the same path', () => {
    pathname = '/products/linen-shirt';
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    fireEvent.change(lookSelect(container), { target: { value: 'qamar.vitrine' } });
    expect(assign).toHaveBeenCalledWith('/products/linen-shirt?look=qamar.vitrine');
  });

  it('keeps other query params and replaces an existing look', () => {
    search = 'sort=new&look=qamar.atelier';
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    fireEvent.change(lookSelect(container), { target: { value: 'qamar.lookbook' } });
    expect(assign).toHaveBeenCalledWith('/products?sort=new&look=qamar.lookbook');
  });

  it('a stored look that is not built shows the first template and a placeholder', () => {
    const { container } = render(<DemoLookBar activeLook="dahab.gold" isBuilt={isBuilt} />);
    expect(templateSelect(container).value).toBe('qamar');
    expect(lookSelect(container).value).toBe('');
    expect(screen.getByText('Choose a look')).toBeTruthy();
  });

  it('renders nothing when no look is built', () => {
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={() => false} />);
    expect(container.innerHTML).toBe('');
  });

  it('is labelled as a demo store, Arabic first', () => {
    lang = 'ar';
    render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    expect(screen.getByRole('region', { name: 'متجر تجريبي' })).toBeTruthy();
    expect(screen.getByLabelText('القالب')).toBeTruthy();
    expect(screen.getByLabelText('الشكل')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'لوك بوك' })).toBeTruthy();
  });

  it('both selects reserve room for their arrow at the inline end, so the text never sits under it (RTL chevron overlap)', () => {
    expect(DEMO_BAR_SELECT_CLASS).toMatch(/\bappearance-none\b/);
    expect(DEMO_BAR_SELECT_CLASS).toMatch(/\bpe-8\b/);
    expect(DEMO_BAR_SELECT_CLASS).toMatch(/\bps-2\b/);
    expect(DEMO_BAR_SELECT_CLASS).toMatch(/\brtl:\[background-position:/);
    expect(DEMO_BAR_SELECT_CLASS).not.toMatch(/\b(px|pl|pr)-\d/);
    lang = 'ar';
    render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    for (const s of document.querySelectorAll('select'))
      expect(s.className).toBe(DEMO_BAR_SELECT_CLASS);
  });

  it('both selects are 16px on a phone, so iOS Safari does not zoom the page when one is tapped', () => {
    // text-sm (14px) alone made the whole demo store zoom in on focus and stay zoomed.
    const sizes = DEMO_BAR_SELECT_CLASS.split(/\s+/).filter(c =>
      /^(\w+:)?text-(xs|sm|base|lg)$/.test(c)
    );
    expect(sizes).toEqual(['text-base', 'sm:text-sm']);
  });

  it('the select boundary is >= 3:1 against the bar on every look (WCAG 1.4.11)', () => {
    // The bar is bg-foreground (the look's ink); the border is the page colour at N% over it.
    const alpha = Number(/\bborder-background\/(\d+)\b/.exec(DEMO_BAR_SELECT_CLASS)?.[1]) / 100;
    expect(alpha).toBeGreaterThan(0);
    const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map(v => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    for (const look of LOOKS) {
      const bar = rgb(look.tokens.ink);
      const page = rgb(look.tokens.page);
      const border = page.map((v, i) => v * alpha + bar[i] * (1 - alpha));
      expect(ratio(border, bar), look.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('every control is at least 44px tall and has a visible focus outline', () => {
    const { container } = render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    for (const s of [templateSelect(container), lookSelect(container)]) {
      expect(s.className).toContain('min-h-11');
      expect(s.className).toContain('focus-visible:outline-2');
    }
  });
});

describe('DemoLookBar: the previewed look survives link clicks (B1-11)', () => {
  function clickLink(attrs: Record<string, string>, init: MouseEventInit = {}) {
    const a = document.createElement('a');
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    a.textContent = 'go';
    document.body.appendChild(a);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    a.dispatchEvent(ev);
    a.remove();
    return ev;
  }

  it('a same-origin link click carries ?look and loads the full document', () => {
    search = 'look=qamar.lookbook';
    render(<DemoLookBar activeLook="qamar.lookbook" isBuilt={isBuilt} />);
    const ev = clickLink({ href: '/products/evening-gown-rose?ref=home#reviews' });
    expect(ev.defaultPrevented).toBe(true);
    expect(assign).toHaveBeenCalledWith(
      '/products/evening-gown-rose?ref=home&look=qamar.lookbook#reviews'
    );
  });

  it('a link that already carries the look is left to the browser', () => {
    search = 'look=qamar.lookbook';
    render(<DemoLookBar activeLook="qamar.lookbook" isBuilt={isBuilt} />);
    const ev = clickLink({ href: '/cart?look=qamar.lookbook' });
    expect(ev.defaultPrevented).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('an external link, a new-tab link, a download and modified clicks are untouched', () => {
    search = 'look=qamar.lookbook';
    render(<DemoLookBar activeLook="qamar.lookbook" isBuilt={isBuilt} />);
    const cases: Array<[Record<string, string>, MouseEventInit]> = [
      [{ href: 'https://ebda.app/' }, {}],
      [{ href: '/products', target: '_blank' }, {}],
      [{ href: '/lookbook.pdf', download: '' }, {}],
      [{ href: '/products' }, { metaKey: true }],
      [{ href: '/products' }, { ctrlKey: true }],
      [{ href: '/products' }, { shiftKey: true }],
      [{ href: '/products' }, { altKey: true }],
      [{ href: '/products' }, { button: 1 }],
    ];
    for (const [attrs, init] of cases) {
      const ev = clickLink(attrs, init);
      expect(ev.defaultPrevented, JSON.stringify([attrs, init])).toBe(false);
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it('with no preview in the URL (the store’s own look), links are not rewritten', () => {
    render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    const ev = clickLink({ href: '/products' });
    expect(ev.defaultPrevented).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a ?look the server did not apply (not built) is not carried', () => {
    search = 'look=souq.catalogue';
    render(<DemoLookBar activeLook="qamar.atelier" isBuilt={isBuilt} />);
    expect(clickLink({ href: '/products' }).defaultPrevented).toBe(false);
  });

  it('stops rewriting once unmounted', () => {
    search = 'look=qamar.lookbook';
    const { unmount } = render(<DemoLookBar activeLook="qamar.lookbook" isBuilt={isBuilt} />);
    unmount();
    expect(clickLink({ href: '/products' }).defaultPrevented).toBe(false);
  });

  it('never writes: choosing a template or look and following links make no request', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    search = 'look=qamar.lookbook';
    const { container } = render(<DemoLookBar activeLook="qamar.lookbook" isBuilt={isBuilt} />);
    fireEvent.change(templateSelect(container), { target: { value: 'souq' } });
    fireEvent.change(lookSelect(container), { target: { value: 'qamar.vitrine' } });
    clickLink({ href: '/products' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledTimes(3);
  });
});

describe('DemoCheckoutNotice', () => {
  it('says ordering is closed, Arabic', () => {
    lang = 'ar';
    render(<DemoCheckoutNotice />);
    expect(screen.getByText('ده متجر تجريبي — الطلبات مقفولة')).toBeTruthy();
  });
  it('says ordering is closed, English', () => {
    render(<DemoCheckoutNotice />);
    expect(screen.getByText('This is a demo store — ordering is closed')).toBeTruthy();
  });
});
