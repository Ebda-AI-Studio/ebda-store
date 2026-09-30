/**
 * Issue 2233 — a role colour on its own 10% tint (`bg-warning/10 text-warning`)
 * is unreadable: amber on amber measured 1.7:1, and every role failed WCAG AA
 * (4.5:1) in the light theme. Tinted pills use the `-ink` token instead.
 *
 * Two gates: (1) each `-ink` meets 4.5:1 against its tint over the card, in
 * BOTH themes, computed from globals.css itself; (2) no admin source pairs a
 * tint with its bare role colour again.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

const ADMIN = resolve(__dirname, '../../apps/admin');
const css = readFileSync(join(ADMIN, 'src/styles/globals.css'), 'utf8');
const ROLES = ['primary', 'success', 'warning', 'info', 'destructive'] as const;

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf('}', start));
}
const light = block(':root');
const dark = block('.dark');

function token(name: string, theme: 'light' | 'dark'): [number, number, number] {
  const read = (b: string) =>
    new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(b);
  // The dark block only overrides some tokens; the rest inherit :root.
  const m = (theme === 'dark' && read(dark)) || read(light);
  if (!m) throw new Error(`token --${name} not found`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function rgb([h, s, l]: [number, number, number]): number[] {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(x => x * 255);
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('tinted-pill ink contrast (issue 2233)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it.each(ROLES)(`${theme}: %s-ink on its 5/10/15%% tints is >= 4.5:1`, role => {
      const card = rgb(token('card', theme));
      for (const a of [0.05, 0.1, 0.15]) {
        const tint = rgb(token(role, theme)).map((v, i) => v * a + card[i] * (1 - a));
        expect(ratio(rgb(token(`${role}-ink`, theme)), tint), `${a}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('control: the bare role colour really does fail on the light warning tint', () => {
    const card = rgb(token('card', 'light'));
    const tint = rgb(token('warning', 'light')).map((v, i) => v * 0.1 + card[i] * 0.9);
    expect(ratio(rgb(token('warning', 'light')), tint)).toBeLessThan(3);
  });
});

describe('no admin source pairs a tint with its bare role colour', () => {
  // Per class STRING, not adjacency: `bg-destructive/10 p-4 text-sm
  // text-destructive` is the same unreadable pair as the adjacent form.
  const ROLE_LIST = ['primary', 'success', 'warning', 'info', 'destructive'];
  const offendingPairs = (src: string): string[] => {
    const out: string[] = [];
    for (const m of src.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
      const cls = m[2];
      for (const r of ROLE_LIST) {
        if (
          new RegExp(`(?<![\\w:-])bg-${r}/(5|10|15)\\b`).test(cls) &&
          new RegExp(`(?<![\\w:-])text-${r}(?![-\\w/])`).test(cls)
        ) {
          out.push(`${r}: ${cls}`);
        }
      }
    }
    return out;
  };
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  walk(join(ADMIN, 'src'));

  it('finds files to scan (control)', () => expect(files.length).toBeGreaterThan(100));

  it('control: the detector flags a non-adjacent pair and passes the ink form', () => {
    expect(offendingPairs(`'bg-warning/10 p-4 text-sm text-warning'`)).toHaveLength(1);
    expect(offendingPairs(`'bg-warning/10 p-4 text-warning-ink hover:text-warning'`)).toEqual([]);
  });

  it('every tinted pill uses the -ink text token', () => {
    const offenders = files.flatMap(f =>
      offendingPairs(readFileSync(f, 'utf8')).map(o => `${f.slice(ADMIN.length + 1)} — ${o}`)
    );
    expect(offenders).toEqual([]);
  });
});
