// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useRef } from 'react';
import { StickyCartTotal } from './StickyCartTotal';

/** One observer per observed element, so a test can report the CTA and the Total row apart. */
const observers: { el: Element; cb: (e: unknown[]) => void }[] = [];
class IO {
  constructor(private cb: (e: unknown[]) => void) {}
  observe(el: Element) {
    observers.push({ el, cb: this.cb });
  }
  disconnect() {}
  unobserve() {}
}
const report = (selector: string, isIntersecting: boolean) =>
  act(() =>
    observers
      .filter(o => o.el.matches(selector))
      .forEach(o => o.cb([{ isIntersecting, target: o.el }]))
  );

function Harness({ withTotal = true }: { withTotal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref}>
        {withTotal && <div data-cart-total="">Total 100</div>}
        <button data-cta="button">Checkout</button>
      </div>
      <StickyCartTotal
        totalLabel="Total"
        total="EGP 100"
        itemCount={1}
        itemCountLabel="1 item"
        href="/checkout"
        label="Checkout"
        anchorRef={ref}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
});

describe('StickyCartTotal waits for the summary Total row too (STOP-2 P2)', () => {
  it('hides while the summary total is in view, even with the CTA below the fold', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness />);
    report('[data-cta]', false); // CTA below the fold
    report('[data-cart-total]', true); // but the total row is on screen
    expect(screen.queryByTestId('sticky-cart-total')).toBeNull();
    report('[data-cart-total]', false); // total scrolled away
    expect(screen.getByTestId('sticky-cart-total')).toBeTruthy();
  });
  it('without a tagged total row the CTA rule alone decides', () => {
    vi.stubGlobal('IntersectionObserver', IO);
    render(<Harness withTotal={false} />);
    report('[data-cta]', false);
    expect(screen.getByTestId('sticky-cart-total')).toBeTruthy();
  });
});
