/**
 * Pre-QA sweep finding 8 (2026-11-10): on a phone the open menu panel ran to 16px above the
 * bottom of the screen while the cookie bar sat fixed over that same strip, so the last row of
 * the menu could not be scrolled clear of the bar. The bar now publishes its height as
 * `--ebda-consent-h` and the panel stops above it. This reads both sources and does the sum,
 * so moving either edge without the other fails here. It names no menu item on purpose: the
 * rule is about the panel's bottom edge, whatever its last row is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '../..');
const css = readFileSync(join(R, 'apps/marketing/src/app/globals.css'), 'utf8');
const tracker = readFileSync(join(R, 'packages/shared/src/tracking/browser.ts'), 'utf8');

/** The phone (max-width: 520px) rule for the menu panel. */
function phonePanelRule(): string {
  const media = css.indexOf('@media (max-width: 520px) {\n  .nav-menu > ul {');
  expect(media, 'phone .nav-menu > ul rule in marketing globals.css').toBeGreaterThan(-1);
  const open = css.indexOf('.nav-menu > ul {', media);
  return css.slice(open, css.indexOf('}', open));
}

describe('phone menu panel vs the cookie bar', () => {
  it('the panel height subtracts the published bar height, with a 0px fallback', () => {
    expect(phonePanelRule()).toMatch(
      /max-height:\s*calc\(100dvh - \d+px - var\(--ebda-consent-h, 0px\)\);/
    );
  });

  it('the panel bottom edge never sits lower than the top of the bar', () => {
    const rule = phonePanelRule();
    const top = Number(/top:\s*(\d+)px/.exec(rule)![1]);
    const reserved = Number(/max-height:\s*calc\(100dvh - (\d+)px/.exec(rule)![1]);
    // Phones always get the compact bar (<= 600px); its offset from the bottom of the screen:
    const barBottom = Number(/bottom:\$\{compact \? (\d+) :/.exec(tracker)![1]);
    // panel bottom = top + (vh - reserved - h); bar top = vh - barBottom - h.
    const panelGapFromBottom = reserved - top;
    expect(panelGapFromBottom).toBeGreaterThanOrEqual(barBottom);
  });

  it('the tracker sets and clears exactly that property on the root element', () => {
    expect(tracker).toContain("setProperty('--ebda-consent-h'");
    expect(tracker).toContain("removeProperty('--ebda-consent-h')");
  });
});
