import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Bloom: a neutral near-black scrim over the pastel pink hero read as a grey slab; the look tints
// the scrim from its own ink. Source gate: the rule targets both scrim placements and keeps the alpha.
describe('jasmine.bloom hero scrim', () => {
  it('is tinted from --foreground at >= 0.72 alpha on both placements', () => {
    const css = readFileSync('apps/web/src/styles/globals.css', 'utf8');
    const i = css.indexOf("[data-look='jasmine.bloom'] [data-part='hero-scrim']");
    expect(i).toBeGreaterThan(-1);
    const rule = css.slice(i, css.indexOf('}', i));
    expect(rule).toContain("[data-part='hero-copy'][data-anchor='corner']");
    expect(rule).toMatch(/hsl\(var\(--foreground\) \/ 0\.82\)/);
  });
});
