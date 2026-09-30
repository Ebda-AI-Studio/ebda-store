/**
 * Regression for #1355 / #1356: the hover-gated image controls in
 * MultiImageGrid and UploadPreview were `md:opacity-0 md:group-hover:opacity-100`
 * with no `group-focus-within` variant, so a keyboard user tabbing to the
 * move/remove buttons on a desktop-width viewport could never see them —
 * they stayed invisible even while focused. A touch tablet at >=768px (no
 * hover, but the buttons are focusable) had the same problem, gated purely
 * on viewport width rather than input capability.
 *
 * The viewport-width gate (`md:...`) was later replaced by the capability
 * gate `.hover-reveal` (`@media (hover: hover) and (pointer: fine)`,
 * globals.css) so a touch tablet at >=768px stays visible-by-default too
 * (issue #1356) — see the doc comments on both components. The
 * `group-focus-within` guarantee this test exists to pin now lives in that
 * shared class's definition rather than inline on each component, so this
 * asserts both: each component opts into `.hover-reveal`, and the CSS class
 * itself still reveals on `.group:focus-within`, not just `.group:hover`.
 *
 * Asserts on source text (a CSS-visibility class combination isn't
 * meaningfully provable by a DOM render test without a real browser's
 * `:focus-within` engine) rather than rendering.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('image-upload controls reveal on keyboard focus, not just hover', () => {
  it('MultiImageGrid: the control overlay opts into the hover-reveal capability gate', () => {
    const source = readFileSync(join(__dirname, 'MultiImageGrid.tsx'), 'utf-8');
    expect(source).toMatch(/\bhover-reveal\b/);
  });

  it('UploadPreview: the remove button opts into the hover-reveal capability gate', () => {
    const source = readFileSync(join(__dirname, 'UploadPreview.tsx'), 'utf-8');
    expect(source).toMatch(/\bhover-reveal\b/);
  });

  it('the hover-reveal capability gate reveals on group-focus-within, not just group-hover', () => {
    const css = readFileSync(join(__dirname, '../../styles/globals.css'), 'utf-8');
    expect(css).toMatch(/\.group:focus-within \.hover-reveal\s*\{/);
  });
});
