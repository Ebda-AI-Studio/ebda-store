// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { useRef } from 'react';

let ioCallback: (
  entries: Array<{ isIntersecting: boolean; boundingClientRect?: { top: number } }>
) => void = () => {};
class IO {
  constructor(cb: typeof ioCallback) {
    ioCallback = cb;
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
  it('appears only when the main button scrolls out of view', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness />);
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
    act(() => ioCallback([{ isIntersecting: false }]));
    expect(screen.getByTestId('sticky-atc')).toBeTruthy();
    expect(document.body.dataset.stickyAtc).toBe('1');
    act(() => ioCallback([{ isIntersecting: true }]));
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
    expect(document.body.dataset.stickyAtc).toBeUndefined();
  });

  it('stays hidden while the button is still below the fold', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness />);
    act(() => ioCallback([{ isIntersecting: false, boundingClientRect: { top: 900 } }]));
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
    act(() => ioCallback([{ isIntersecting: false, boundingClientRect: { top: -50 } }]));
    expect(screen.getByTestId('sticky-atc')).toBeTruthy();
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
