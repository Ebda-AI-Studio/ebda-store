/**
 * a11y P2-11 / K-05 (independent a11y audit): focus rings used alpha 0.6 (the
 * global baseline) and 0.5 rings stood alone, compositing near 3.5:1 on the
 * Lookbook indigo. A focus indicator is opaque, or a low-alpha ring is paired
 * with an opaque focus border.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/web/src');
function walk(d: string): string[] {
  return readdirSync(d).flatMap(f => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

describe('K-05: no low-alpha focus ring alone', () => {
  it('the global focus-visible baseline is opaque', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8');
    const base = /:where\(button, a[^{]*\):focus-visible \{([^}]*)\}/.exec(css);
    expect(base).not.toBeNull();
    expect(base![1]).toMatch(/outline: 2px solid hsl\(var\(--primary\)\);/);
  });

  it('every alpha focus ring has an opaque focus border beside it', () => {
    const bad: string[] = [];
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/className="([^"]*)"/g)) {
        const cls = m[1];
        if (!/\bfocus(-visible)?:ring-[a-z-]+\/\d+/.test(cls)) continue;
        if (/\bfocus(-visible)?:border-(primary|foreground|ring)\b/.test(cls)) continue;
        bad.push(`${relative(SRC, f)}: ${cls.match(/focus(-visible)?:ring-[a-z-]+\/\d+/)![0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
