// @vitest-environment jsdom
/** STOP-2 a11y minors M1 and M2, plus the sticky-header offset (P1-1). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AutoplayToggle } from '../../apps/web/src/templates/shared/AutoplayToggle';
import { smoothScrollLeftBy, smoothScrollLeftTo } from '../../apps/web/src/lib/smooth-scroll';
import { getLook } from '../../packages/shared/src/looks/registry';
import { StickyHeaderOffset } from '../../apps/web/src/components/StickyHeaderOffset';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('M1: one toggle pattern', () => {
  it('the label flips Pause / Play and there is no aria-pressed', () => {
    const labels = { pause: 'Pause', play: 'Play' };
    const a = render(<AutoplayToggle paused={false} onToggle={() => {}} labels={labels} />);
    expect(a.getByRole('button').getAttribute('aria-label')).toBe('Pause');
    expect(a.getByRole('button').hasAttribute('aria-pressed')).toBe(false);
    a.rerender(<AutoplayToggle paused onToggle={() => {}} labels={labels} />);
    expect(a.getByRole('button').getAttribute('aria-label')).toBe('Play');
    expect(a.getByRole('button').hasAttribute('aria-pressed')).toBe(false);
  });
});

describe('M2: reduced motion never glides', () => {
  const el = () => {
    const calls: Array<{ left: number; behavior: string }> = [];
    return {
      calls,
      node: {
        scrollTo: (o: { left: number; behavior: string }) => calls.push(o),
        scrollBy: (o: { left: number; behavior: string }) => calls.push(o),
      } as unknown as HTMLElement,
    };
  };
  it.each([
    [true, 'auto'],
    [false, 'smooth'],
  ])('prefers-reduced-motion=%s -> %s', (reduce, behavior) => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && /reduce/.test(q) }));
    const e = el();
    smoothScrollLeftTo(e.node, 10);
    smoothScrollLeftBy(e.node, 20);
    expect(e.calls.map(c => c.behavior)).toEqual([behavior, behavior]);
  });
});

describe('P1-1: the sticky header offset', () => {
  it('publishes the header height as --header-h only while it is sticky, and cleans up', () => {
    class RO {
      constructor(public cb: () => void) {}
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    const header = document.createElement('header');
    header.style.position = 'sticky';
    Object.defineProperty(header, 'offsetHeight', { value: 120, configurable: true });
    const wrap = document.createElement('div');
    Object.defineProperty(wrap, 'offsetHeight', { value: 3000, configurable: true });
    wrap.appendChild(header);
    document.body.appendChild(wrap);
    const r = render(<StickyHeaderOffset />);
    expect(document.documentElement.style.getPropertyValue('--header-h')).toBe('120px');
    r.unmount();
    expect(document.documentElement.style.getPropertyValue('--header-h')).toBe('');
    wrap.remove();
  });
  it('a sticky header with no room to stick (parent as tall as it) publishes 0px', () => {
    class RO {
      constructor(public cb: () => void) {}
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    const header = document.createElement('header');
    header.style.position = 'sticky';
    Object.defineProperty(header, 'offsetHeight', { value: 68, configurable: true });
    const wrap = document.createElement('div');
    wrap.setAttribute('data-zone', 'header');
    Object.defineProperty(wrap, 'offsetHeight', { value: 68, configurable: true });
    wrap.appendChild(header);
    document.body.appendChild(wrap);
    const r = render(<StickyHeaderOffset />);
    expect(document.documentElement.style.getPropertyValue('--header-h')).toBe('0px');
    r.unmount();
    wrap.remove();
  });
  it('globals.css turns it into scroll-padding-top, and ShopChrome mounts the component', () => {
    const root = path.resolve(__dirname, '../..');
    const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8');
    expect(css).toMatch(/html\s*\{\s*scroll-padding-top:\s*calc\(var\(--header-h,\s*0px\)/);
    // a sticky sub-bar (the Lamma menu tabs) adds its own height to the same offset (B4 a11y P1-1)
    expect(css).toContain('var(--sticky-extra, 0px)');
    const chrome = readFileSync(path.join(root, 'apps/web/src/components/ShopChrome.tsx'), 'utf8');
    expect(chrome).toContain('<StickyHeaderOffset />');
  });
});

describe('STOP-2 re-audit minors (R1, R2, M3, price, chip, stage)', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

  it('R1: Dahab renders its own <header> (the one banner) and the offset measures the wrapper or the header', () => {
    const dahab = read('apps/web/src/templates/dahab/Header.tsx');
    expect(dahab).toMatch(/\n\s*<header\b/);
    expect(dahab).not.toMatch(/return \(\s*<div\s+className=\{cx\(\s*'border-b transition/);
    const off = read('apps/web/src/components/StickyHeaderOffset.tsx');
    expect(off).toContain('[data-zone="header"]');
  });

  it('R1: --header-h follows a sticky ShopChrome wrapper even when the skin header is not sticky', () => {
    class RO {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    const wrap = document.createElement('div');
    wrap.setAttribute('data-zone', 'header');
    wrap.style.position = 'sticky';
    Object.defineProperty(wrap, 'offsetHeight', { value: 96, configurable: true });
    const header = document.createElement('header'); // static: not sticky by itself
    wrap.appendChild(header);
    document.body.appendChild(wrap);
    // a sticky box only sticks inside a taller parent (jsdom has no layout: say how tall the page is)
    Object.defineProperty(document.body, 'offsetHeight', { value: 3000, configurable: true });
    render(<StickyHeaderOffset />);
    expect(document.documentElement.style.getPropertyValue('--header-h')).toBe('96px');
    cleanup();
    wrap.remove();
    delete (document.body as unknown as Record<string, unknown>).offsetHeight;
  });

  it('R2: every field type draws its error boundary in the destructive ink', () => {
    for (const f of ['Input', 'Select', 'Textarea'])
      expect(read(`packages/ui/src/components/${f}.tsx`), f).toMatch(/border-destructive-ink/);
    const gov = read('apps/web/src/app/checkout/_components/GovernorateAreaSelect.tsx');
    expect(gov).toMatch(/border-destructive-ink/);
    expect(gov).toMatch(/aria-invalid=\{hasError \? true : undefined\}/);
    const css = read('apps/web/src/styles/globals.css');
    expect(css).toMatch(
      /:is\(input, select, textarea\)\[aria-invalid='true'\]\s*\{\s*border-color: hsl\(var\(--destructive-ink/
    );
  });

  it('price: the storefront formatter joins number and currency with a no-break space, both locales', async () => {
    const { renderHook } = await import('@testing-library/react');
    vi.doMock('../../apps/web/src/contexts/LanguageContext', () => ({
      useLanguage: () => ({ language: 'ar' }),
    }));
    vi.doMock('../../apps/web/src/hooks/useNumerals', () => ({ useStoreNumerals: () => 'latn' }));
    vi.resetModules();
    const { useLocalePrice } = await import('../../apps/web/src/hooks/useLocalePrice');
    const { result } = renderHook(() => useLocalePrice());
    const out = result.current(3200000);
    expect(out).toBe('32,000 ج.م');
    expect(out).not.toContain(' ');
    vi.doUnmock('../../apps/web/src/contexts/LanguageContext');
    vi.doUnmock('../../apps/web/src/hooks/useNumerals');
  });

  it('chip: the sale chip reads --chip-bg (Night: brass) and the PDP discount pill is not the error red on a look', () => {
    expect(read('apps/web/src/templates/shared/look-card.ts')).toContain(
      'var(--chip-bg, var(--accent))'
    );
    expect(read('apps/web/src/styles/globals.css')).toMatch(
      /\[data-look='souq\.night'\]\s*\{\s*--chip-bg: var\(--primary\)/
    );
    const pdp = read('apps/web/src/app/products/[slug]/ProductDetailClient.tsx');
    expect(pdp).toContain('style={LOOK_CHIP_STYLE}');
  });

  it('Showroom keeps a card action on every card (no `quiet` mode that hides it on a sized product)', () => {
    // The look registry object itself, walked for any `cardCta: 'quiet'` (no text window over registry.ts).
    const showroom = getLook('souq.showroom');
    expect(showroom, 'souq.showroom is registered').toBeDefined();
    const quiet: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          if (k === 'cardCta' && x === 'quiet') quiet.push(`${at}.${k}`);
          walk(x, `${at}.${k}`);
        }
    };
    walk(showroom, 'souq.showroom');
    expect(quiet).toEqual([]);
    expect(read('apps/web/src/styles/globals.css')).toContain(
      "[data-look='souq.showroom'] article :is(a, button).mt-auto.w-full"
    );
  });

  // M3 (search form after the logo in the DOM, before nav and actions): tests/unit/souq-header-dom-order.test.tsx renders the Header.
});
