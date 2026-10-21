/**
 * Quality bar § 10 rule (e) (W4, WCAG 2.2.2): every storefront surface that moves on its own (a
 * timer that advances content, an autoplaying video) has a visible pause toggle and pauses while
 * focus is inside. Ebda's own marketing landing (`components/landing`, `components/ui`) is out of
 * scope.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../apps/web/src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const p = path.join(d, n);
    if (statSync(p).isDirectory()) return n === 'landing' || n === 'ui' ? [] : walk(p);
    return /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n) ? [p] : [];
  });

/** setInterval used as a CLOCK (no content moves): named so the exemption stays visible. */
const CLOCKS: Record<string, string> = {
  'app/checkout/CheckoutClient.tsx': 'minute ticker that re-evaluates delivery-window availability',
  'app/checkout/success/InstapayCard.tsx': 'a 30s poll of the transfer status (no visible motion)',
};

const movers = walk(WEB).filter(f => {
  if (CLOCKS[path.relative(WEB, f)]) return false;
  const s = readFileSync(f, 'utf8');
  return /setInterval\(/.test(s) || /<video\b[\s\S]{0,400}autoPlay/.test(s);
});

describe('rule (e): autoplay has a pause toggle and a focus pause', () => {
  it('finds the moving surfaces (not vacuous)', () => {
    expect(movers.map(f => path.relative(WEB, f)).sort()).toEqual(
      expect.arrayContaining([
        'components/commerce/HeroVideo.tsx',
        'templates/shared/HeroSlider.tsx',
        'templates/shared/ProductCarousel.tsx',
      ])
    );
  });
  it.each(movers.map(f => [path.relative(WEB, f), f]))('%s', (_rel, f) => {
    const s = readFileSync(f, 'utf8');
    expect(s, 'visible toggle').toMatch(/AutoplayToggle|data-autoplay-toggle/);
    if (/setInterval\(/.test(s)) expect(s, 'focus pause').toMatch(/onFocus=/);
  });
});
