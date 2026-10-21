/**
 * `OutOfStockRibbon`'s configurable-pill collision avoidance — issue #548:
 * the guard used to reserve space on the WRONG side for the default
 * top-start placement (it only actually cleared the heart when the
 * merchant explicitly chose top-end), so a merchant who set ANY oosLabel*
 * field while leaving placement at its default still got the pill under
 * the heart. Rendered here (not just unit-tested on the resolver function)
 * because the bug was specifically about which CSS classes reach the DOM.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {} }),
}));

const { OutOfStockRibbon } = await import('./ProductCardCta');

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    React.createElement(OutOfStockRibbon as never, {
      inStock: false,
      // Any oosLabel* field switches on the configurable-pill path.
      oosLabelTextEn: 'Sold Out',
      ...props,
    })
  );
}

describe('OutOfStockRibbon — issue #548 collision avoidance', () => {
  it('no reservation → the default (unset placement) stays at top-start', () => {
    const html = render({});
    expect(html).toMatch(/\btop-2 start-2\b/);
  });

  it('StorefrontProductCard-shaped heart (topStartReserved) moves the DEFAULT pill to top-end', () => {
    // This is the exact #548 bug: previously a max-width-only guard left the
    // pill's *start* edge still under the heart. It must now render at a
    // genuinely different corner.
    const html = render({ topStartReserved: true });
    expect(html).toMatch(/\btop-2 end-2\b/);
    expect(html).not.toMatch(/\btop-2 start-2\b/);
  });

  it('a compare button (topStartReserved) moves an EXPLICIT top-start choice too', () => {
    const html = render({ oosLabelPlacement: 'top-start', topStartReserved: true });
    expect(html).toMatch(/\btop-2 end-2\b/);
  });

  it('modern/elegant-shaped heart (topEndReserved) leaves the top-start DEFAULT untouched', () => {
    // modern/elegant hearts sit at top-END, not top-start — the OOS pill's
    // default corner never collides with them, so nothing should move.
    const html = render({ topEndReserved: true });
    expect(html).toMatch(/\btop-2 start-2\b/);
  });

  it('an explicit top-end placement moves off a reserved top-end (heart) corner', () => {
    const html = render({ oosLabelPlacement: 'top-end', topEndReserved: true });
    expect(html).toMatch(/\btop-2 start-2\b/);
  });

  it('both top corners reserved (compare + heart) drops the pill to the bottom, same side', () => {
    const html = render({ topStartReserved: true, topEndReserved: true });
    expect(html).toMatch(/\bbottom-2 start-2\b/);
  });

  it('a bottom placement is never touched — no action button ever lives there', () => {
    const html = render({
      oosLabelPlacement: 'bottom-end',
      topStartReserved: true,
      topEndReserved: true,
    });
    expect(html).toMatch(/\bbottom-2 end-2\b/);
  });

  it('the width safety net still applies on whichever top corner it lands on', () => {
    const html = render({ topStartReserved: true });
    expect(html).toMatch(/max-w-\[calc\(100%-3\.5rem\)\]/);
  });

  it('the width safety net is dropped once avoidance drops the pill to the bottom', () => {
    const html = render({ topStartReserved: true, topEndReserved: true });
    expect(html).not.toMatch(/max-w-\[calc\(100%-3\.5rem\)\]/);
  });
});
