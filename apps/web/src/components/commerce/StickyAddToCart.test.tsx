// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let ioCallback: (
  entries: Array<{ isIntersecting: boolean; boundingClientRect?: { top: number } }>
) => void = () => {};
let ioOptions: IntersectionObserverInit | undefined;
class IO {
  constructor(cb: typeof ioCallback, opts?: IntersectionObserverInit) {
    ioCallback = cb;
    ioOptions = opts;
  }
  observe() {}
  disconnect() {}
}

import { StickyAddToCart } from './StickyAddToCart';
import { StickyCartTotal } from './StickyCartTotal';

function Harness(p: { onAdd?: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref}>
        <button>main</button>
      </div>
      <StickyAddToCart
        anchorRef={ref}
        title="Linen Abaya"
        price="EGP 100"
        label="Add"
        disabled={p.disabled}
        onAdd={p.onAdd ?? (() => {})}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StickyAddToCart', () => {
  it('is hidden before the observer reports, then follows the real position', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness />);
    // no flash: nothing shown until the first observer callback says where the button is
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
    expect(document.body.dataset.stickyAtc).toBeUndefined();
    // button IN view on load -> stays hidden
    act(() => ioCallback([{ isIntersecting: true, boundingClientRect: { top: 400 } }]));
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
  });

  it('treats the area under the fixed tab bar as off-screen (bottom rootMargin = tab + safe area)', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    // the probe element resolves calc(var(--bottom-tab-h) + env(safe-area-inset-bottom)):
    // 69px tab + 34px home-indicator inset on an iPhone
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 103 } as DOMRect);
    try {
      render(<Harness />);
      expect(ioOptions?.rootMargin).toBe('0px 0px -103px 0px');
      // fully inside the reachable area, so a half-covered button still gets the bar
      expect(ioOptions?.threshold).toBe(1);
      // the button sits in the covered band: the observer reports it outside the shrunken root
      act(() => ioCallback([{ isIntersecting: false, boundingClientRect: { top: 780 } }]));
      expect(screen.getByTestId('sticky-atc')).toBeTruthy();
    } finally {
      rect.mockRestore();
    }
  });

  it('shows from first paint when the button starts below the fold (B0-49)', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness />);
    act(() => ioCallback([{ isIntersecting: false, boundingClientRect: { top: 1100 } }]));
    expect(screen.getByTestId('sticky-atc')).toBeTruthy();
    expect(document.body.dataset.stickyAtc).toBe('1');
  });

  it('shows when scrolled past, and hides again while the button is visible', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness />);
    act(() => ioCallback([{ isIntersecting: false, boundingClientRect: { top: -50 } }]));
    expect(screen.getByTestId('sticky-atc')).toBeTruthy();
    act(() => ioCallback([{ isIntersecting: true, boundingClientRect: { top: 300 } }]));
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
    expect(document.body.dataset.stickyAtc).toBeUndefined();
  });

  it('stays hidden without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Harness />);
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
  });

  it('lifts by the shared tab-bar var, not a literal 56px, on both PDP paths', () => {
    const dir = path.resolve(__dirname, '../..');
    const files = [
      'components/commerce/StickyAddToCart.tsx',
      'components/commerce/StickyCartTotal.tsx',
      'templates/dahab/ProductDetail.tsx',
    ];
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).toContain('var(--bottom-tab-h)');
      expect(src, f).not.toMatch(/calc\(56px/);
    }
    // the Dahab pinned bar shares the one off-screen rule with the default path
    const dahab = readFileSync(path.join(dir, 'templates/dahab/ProductDetail.tsx'), 'utf8');
    expect(dahab).toContain('useAnchorOffscreen(buyRef)');
    const tab = readFileSync(path.join(dir, 'templates/shared/BottomTabBar.tsx'), 'utf8');
    expect(tab).toContain('--bottom-tab-h');
    expect(readFileSync(path.join(dir, 'styles/globals.css'), 'utf8')).toMatch(
      /--bottom-tab-h:\s*69px/
    );
  });

  it('publishes the bar height for the toast/widget lift and clears it on unmount', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    const off = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(61);
    try {
      const { unmount } = render(<Harness />);
      act(() => ioCallback([{ isIntersecting: false }]));
      expect(document.body.style.getPropertyValue('--sticky-bar-h')).toBe('61px');
      unmount();
      expect(document.body.style.getPropertyValue('--sticky-bar-h')).toBe('');
    } finally {
      off.mockRestore();
    }
  });

  it('removes the body flag on unmount', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    const { unmount } = render(<Harness />);
    act(() => ioCallback([{ isIntersecting: false }]));
    expect(document.body.dataset.stickyAtc).toBe('1');
    unmount();
    expect(document.body.dataset.stickyAtc).toBeUndefined();
  });

  it('calls onAdd once and respects disabled', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    const onAdd = vi.fn();
    const { rerender } = render(<Harness onAdd={onAdd} />);
    act(() => ioCallback([{ isIntersecting: false }]));
    fireEvent.click(screen.getByText('Add'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    rerender(<Harness onAdd={onAdd} disabled />);
    fireEvent.click(screen.getByText('Add'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('StickyCartTotal', () => {
  const base = {
    totalLabel: 'Subtotal',
    total: 'EGP 300',
    itemCountLabel: '2 items',
    href: '/checkout',
    label: 'Checkout',
  };
  it('renders nothing for an empty cart', () => {
    render(<StickyCartTotal {...base} itemCount={0} />);
    expect(screen.queryByTestId('sticky-cart-total')).toBeNull();
    expect(document.body.dataset.stickyCart).toBeUndefined();
  });
  it('links to checkout and sets the body flag when items exist', () => {
    const { unmount } = render(<StickyCartTotal {...base} itemCount={2} />);
    expect(screen.getByText('Checkout').closest('a')?.getAttribute('href')).toBe('/checkout');
    expect(document.body.dataset.stickyCart).toBe('1');
    unmount();
    expect(document.body.dataset.stickyCart).toBeUndefined();
  });
  it('is a disabled button with the message when blocked', () => {
    render(<StickyCartTotal {...base} itemCount={2} disabled blockedMessage="Minimum order 500" />);
    expect(screen.getByText('Minimum order 500')).toBeTruthy();
    const btn = screen.getByText('Checkout') as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.disabled).toBe(true);
  });
});
