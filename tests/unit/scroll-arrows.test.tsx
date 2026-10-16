// @vitest-environment jsdom
/**
 * a11y P2-13 (independent a11y audit): the desktop category and shop-the-look rows
 * had no arrow buttons, so a mouse user without a trackpad could not reach the
 * tail. Every horizontal row gets the same prev/next pair as ProductCarousel:
 * real 44px buttons, named, mirrored for RTL, inert at the row's edges.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScrollArrows } from '../../apps/web/src/templates/shared/ScrollArrows';
import { smallTargets } from '../helpers/target-size';

afterEach(cleanup);

function Row({ isRtl }: { isRtl: boolean }) {
  const ref = useRef<HTMLUListElement>(null);
  return (
    <div className="relative">
      <ScrollArrows scrollRef={ref} isRtl={isRtl} />
      <ul ref={ref}>
        <li>a</li>
      </ul>
    </div>
  );
}

describe('ScrollArrows', () => {
  it.each([false, true])('names both buttons, 44px, inert at the edges (rtl=%s)', isRtl => {
    const { container } = render(<Row isRtl={isRtl} />);
    const prev = container.querySelector('[data-scroll-prev]') as HTMLButtonElement;
    const next = container.querySelector('[data-scroll-next]') as HTMLButtonElement;
    expect(prev.getAttribute('aria-label')).toBe(isRtl ? 'السابق' : 'Previous');
    expect(next.getAttribute('aria-label')).toBe(isRtl ? 'التالي' : 'Next');
    // jsdom has no layout: nothing overflows, so both are disabled.
    expect(prev.disabled && next.disabled).toBe(true);
    expect(smallTargets(container, 44, { requireWidth: true })).toEqual([]);
    expect(prev.querySelector('svg')!.getAttribute('class')).toMatch(/rtl:-scale-x-100/);
  });

  it.each(['templates/shared/CategoryStrip.tsx', 'builder/sections/ShopTheLookSection.tsx'])(
    '%s renders the arrows on its row',
    f => {
      const src = readFileSync(join(__dirname, '../../apps/web/src', f), 'utf8');
      expect(src).toMatch(/<ScrollArrows\b[^>]*scrollRef=\{/);
    }
  );
});
