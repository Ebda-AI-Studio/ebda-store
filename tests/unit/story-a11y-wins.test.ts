import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Ruling A11Y-WINS-1: the AA contrast values of the dimmed story steps survive the scroll-glide change, and every
// pinning / scrubbing / dimming rule sits behind the scripting + no-preference media gate (reduced motion = static story).
// the story is /store-only, so its rules live in route-store.css (Ruling CSS-BUDGET-726-1)
const css = readFileSync(
  path.resolve(__dirname, '../../apps/marketing/src/app/route-store.css'),
  'utf8'
);
const GATE = '@media (scripting: enabled) and (prefers-reduced-motion: no-preference) {';

describe('story steps: accessibility wins over the glide (A11Y-WINS-1)', () => {
  it('dimmed steps keep the AA opacity floor and full-ink text, inside the motion gate', () => {
    expect(css).toMatch(/0\.62 \+ 0\.38 \* var\(--act\)/);
    expect(css).not.toMatch(/0\.38 \+ 0\.62 \* var\(--act\)/);
    const gated = css.split(GATE).slice(1).join(GATE);
    expect(gated).toMatch(/\.story-step-d\s*\{\s*color: var\(--fg\)/);
  });

  it('the pinned height and sticky stage only apply under the motion gate', () => {
    const outside = css
      .split(GATE)
      .map((chunk, i) => (i === 0 ? chunk : chunk.replace(/^[\s\S]*?\n}\n/, '')));
    expect(outside.join('')).not.toMatch(/\.story\s*\{[^}]*height:\s*400vh/);
    expect(css).not.toMatch(/\.story\[data-live\]/);
  });
});
