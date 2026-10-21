// @vitest-environment jsdom
/** STOP-2 a11y minors M1 and M2, plus the sticky-header offset (P1-1). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AutoplayToggle } from '../../apps/web/src/templates/shared/AutoplayToggle';
import { smoothScrollLeftBy, smoothScrollLeftTo } from '../../apps/web/src/lib/smooth-scroll';
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
    document.body.appendChild(header);
    const r = render(<StickyHeaderOffset />);
    expect(document.documentElement.style.getPropertyValue('--header-h')).toBe('120px');
    r.unmount();
    expect(document.documentElement.style.getPropertyValue('--header-h')).toBe('');
    header.remove();
  });
  it('globals.css turns it into scroll-padding-top, and ShopChrome mounts the component', () => {
    const root = path.resolve(__dirname, '../..');
    const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8');
    expect(css).toMatch(/html\s*\{\s*scroll-padding-top:\s*calc\(var\(--header-h,\s*0px\)/);
    const chrome = readFileSync(path.join(root, 'apps/web/src/components/ShopChrome.tsx'), 'utf8');
    expect(chrome).toContain('<StickyHeaderOffset />');
  });
});
