/**
 * Every navigation wait in the production smoke suite states what it waits for.
 *
 * Playwright's `waitForURL` and `goto` default to `waitUntil: 'load'` — every
 * resource on the page, including product imagery and third-party pixels. The
 * suite deliberately uses `domcontentloaded` everywhere, because it asserts
 * that pages render and navigate, not that every asset arrives.
 *
 * One line was left implicit, and it defaulted to 'load'. It then timed out
 * waiting for assets on a page that had already navigated, so a healthy deploy
 * reported failure and `notify-failure` proposed a rollback — on every deploy.
 * A check that cries wolf is worse than no check, because it trains the alert
 * to be ignored.
 *
 * Asserted structurally: a default is invisible at the call site, so reviewing
 * for it does not work. The file has to be made to say.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const SMOKE_DIR = new URL('../smoke/', import.meta.url);
const files = readdirSync(SMOKE_DIR).filter(f => f.endsWith('.spec.ts'));

describe('production smoke navigation waits are explicit', () => {
  it('finds the smoke specs at all', () => {
    // Guards against this suite silently passing because the directory moved.
    expect(files.length, 'no smoke specs found — has the path changed?').toBeGreaterThan(0);
  });

  it.each(files)('%s: every goto and waitForURL waits for domcontentloaded', file => {
    const src = readFileSync(new URL(file, SMOKE_DIR), 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, i) => {
      if (!/page\.(goto|waitForURL)\(/.test(line)) return;
      // The call may span lines; take the next few so an options object on a
      // following line still counts.
      const call = lines.slice(i, i + 6).join(' ');
      // A single positive value-check, not a presence check + a denylist of
      // one literal (#1646): the old pair passed on `waitUntil: 'networkidle'`
      // (present, not 'load') and on a double-quoted `waitUntil: "load"`
      // (denylist was a single-quoted literal). Pin the one value this suite
      // actually wants, in any quote style.
      expect(
        call,
        `${file}:${i + 1} does not wait for domcontentloaded — it will default to (or was set to) ` +
          `'load'/'networkidle', waiting for assets instead of navigation`
      ).toMatch(/waitUntil:\s*['"`]domcontentloaded['"`]/);
    });
  });
});
