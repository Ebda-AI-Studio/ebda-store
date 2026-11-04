import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** Audit 2026-11-03 (b, All): no tracking on Arabic text anywhere. The reset is one global rule. */
describe('arabic letter-spacing guard', () => {
  const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
  it('resets letter-spacing and text-transform on every descendant of an Arabic page, !important', () => {
    expect(css).toMatch(
      /:lang\(ar\),\s*:lang\(ar\) \*\s*\{\s*letter-spacing: normal !important;\s*text-transform: none !important;/
    );
  });
  it('the reset beats inline styles (a merchant typography zone cannot re-add tracking)', () => {
    expect(css).toContain('letter-spacing: normal !important');
  });
});
