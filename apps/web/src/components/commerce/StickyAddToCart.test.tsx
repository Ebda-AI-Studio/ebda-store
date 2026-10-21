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

  it('C-04: every task bar sits at the bottom edge (it REPLACES the tab bar), never stacked on it', () => {
    const dir = path.resolve(__dirname, '../..');
    const files = [
      'components/commerce/StickyAddToCart.tsx',
      'components/commerce/StickyCartTotal.tsx',
      'templates/dahab/ProductDetail.tsx',
    ];
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      // No lift above the tab bar: the tab bar is hidden while a task bar shows.
      expect(src, f).not.toMatch(/bottom-\[calc\(var\(--bottom-tab-h\)/);
      expect(src, f).not.toMatch(/calc\(56px/);
      expect(src, f).toMatch(/fixed inset-x-0 bottom-0 /);
      // the safe-area inset lives in the bar's own padding
      expect(src, f).toContain('env(safe-area-inset-bottom))]');
      expect(src, f).toContain('useStickyBarHeight(');
    }
    // the Dahab pinned bar shares the one off-screen rule with the default path
    const dahab = readFileSync(path.join(dir, 'templates/dahab/ProductDetail.tsx'), 'utf8');
    expect(dahab).toContain('useAnchorOffscreen(buyRef)');
    const tab = readFileSync(path.join(dir, 'templates/shared/BottomTabBar.tsx'), 'utf8');
    expect(tab).toContain('--bottom-tab-h');
    expect(tab).toContain('data-bottom-tab-bar');
    expect(readFileSync(path.join(dir, 'styles/globals.css'), 'utf8')).toMatch(
      /--bottom-tab-h:\s*69px/
    );
  });

  it('C-04: while shown it marks <html data-task-bar> and publishes its height on <html>; both clear on hide and unmount', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    const off = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(61);
    const root = document.documentElement;
    try {
      const { unmount } = render(<Harness />);
      expect(root.dataset.taskBar).toBeUndefined();
      act(() => ioCallback([{ isIntersecting: false }]));
      expect(root.dataset.taskBar).toBe('1');
      expect(root.style.getPropertyValue('--sticky-bar-h')).toBe('61px');
      // main button back on screen: the bar hides and the tab bar returns
      act(() => ioCallback([{ isIntersecting: true }]));
      expect(root.dataset.taskBar).toBeUndefined();
      expect(root.style.getPropertyValue('--sticky-bar-h')).toBe('');
      act(() => ioCallback([{ isIntersecting: false }]));
      unmount();
      expect(root.dataset.taskBar).toBeUndefined();
      expect(root.style.getPropertyValue('--sticky-bar-h')).toBe('');
    } finally {
      off.mockRestore();
    }
  });

  it('C-04: the cart total bar marks <html data-task-bar> while the cart has items', () => {
    const root = document.documentElement;
    const { rerender, unmount } = render(
      <StickyCartTotal
        totalLabel="Total"
        total="EGP 100"
        itemCount={1}
        itemCountLabel="1 item"
        href="/checkout"
        label="Checkout"
      />
    );
    expect(root.dataset.taskBar).toBe('1');
    rerender(
      <StickyCartTotal
        totalLabel="Total"
        total="EGP 0"
        itemCount={0}
        itemCountLabel="0 items"
        href="/checkout"
        label="Checkout"
      />
    );
    expect(root.dataset.taskBar).toBeUndefined();
    unmount();
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

// Taste re-audit P2-3 (Y-05): at 390 the sticky cart total sat on screen while the summary's
// own total and checkout button were visible, and in the full page it covered the coupon field.
// Like the PDP buy bar, the cart bar shows only once the summary's checkout button leaves view.
function CartHarness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref}>
        <a href="/checkout" data-cta="button">
          Checkout
        </a>
      </div>
      <StickyCartTotal
        anchorRef={ref}
        totalLabel="Total"
        total="EGP 100"
        itemCount={1}
        itemCountLabel="1 item"
        href="/checkout"
        label="Checkout"
      />
    </div>
  );
}
describe('StickyCartTotal follows the summary checkout button (P2-3)', () => {
  it('hidden while the summary CTA is in view, shown once it leaves', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<CartHarness />);
    act(() => ioCallback([{ isIntersecting: true }]));
    expect(screen.queryByTestId('sticky-cart-total')).toBeNull();
    act(() => ioCallback([{ isIntersecting: false }]));
    expect(screen.getByTestId('sticky-cart-total')).toBeTruthy();
  });
});
