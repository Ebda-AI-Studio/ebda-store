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
  //
  // Issues 2313 / 2322 / 2323 — the first version of this gate only saw the
  // un-prefixed token form at alphas 5/10/15, so three spellings of the same
  // defect passed it: a `dark:` pair (`dark:bg-info/30 dark:text-info`, 3.4:1),
  // the arbitrary-value form (`bg-[hsl(var(--success))]/10 …
  // text-[hsl(var(--success))]`, 2.8:1) and a double opacity modifier
  // (`dark:bg-destructive/30/30`, which Tailwind drops, so the pill had no
  // dark background). The gate now RESOLVES each pill per theme — the text
  // class and tint alpha that actually apply in light and in dark — and
  // measures that pair against globals.css, at whatever alpha the source uses.
  const ROLE_LIST = ['primary', 'success', 'warning', 'info', 'destructive'] as const;
  type Role = (typeof ROLE_LIST)[number];
  const TINT_MAX = 40; // above this the class is a solid fill, not a tint
  const OPACITY_SCALE = new Set(Array.from({ length: 21 }, (_, i) => i * 5));
  const COLOUR_OPACITY =
    /(?<![\w/-])((?:[\w-]+:)*(?:bg|text|border|ring|from|via|to|fill|stroke|outline|divide|shadow|decoration|placeholder)-[a-z][\w-]*)\/(\d+)(?![\w/.])/g;

  const classStrings = (src: string): string[] =>
    [...src.matchAll(/(["'`])([^"'`\n]*)\1/g)].map(m => m[2]);

  /** Every problem in one class string: a bare role colour on its tint, an
   *  -ink under 4.5:1 on the tint it actually sits on, per theme. */
  const pillProblems = (cls: string): string[] => {
    const out: string[] = [];
    const tokens = cls.split(/\s+/);
    const alpha = (variant: '' | 'dark:', r: Role): number | undefined => {
      for (const t of tokens) {
        const m = new RegExp(`^${variant}bg-${r}/(\\d+)$`).exec(t);
        if (m && Number(m[1]) <= TINT_MAX) return Number(m[1]);
      }
      return undefined;
    };
    const text = (variant: '' | 'dark:', r: Role): 'bare' | 'ink' | undefined => {
      if (tokens.includes(`${variant}text-${r}-ink`)) return 'ink';
      if (tokens.includes(`${variant}text-${r}`)) return 'bare';
      return undefined;
    };
    for (const r of ROLE_LIST) {
      const baseText = text('', r);
      const darkText = text('dark:', r) ?? baseText;
      // `hover:` tints are out of scope: at rest that text sits on the plain
      // surface (see Ruling YWA-1).
      const lightTints = [alpha('', r)].filter((a): a is number => a !== undefined);
      const darkTints = [alpha('dark:', r) ?? alpha('', r)].filter(
        (a): a is number => a !== undefined
      );
      const check = (theme: 'light' | 'dark', t: 'bare' | 'ink' | undefined, tints: number[]) => {
        if (!t) return;
        for (const a of tints) {
          if (t === 'bare') {
            out.push(`${theme}: bare text-${r} on its ${a}% tint`);
            continue;
          }
          const card = rgb(token('card', theme));
          const tint = rgb(token(r, theme)).map((v, i) => (v * a) / 100 + card[i] * (1 - a / 100));
          const c = ratio(rgb(token(`${r}-ink`, theme)), tint);
          if (c < 4.5) out.push(`${theme}: ${r}-ink on ${a}% tint = ${c.toFixed(2)}:1`);
        }
      };
      check('light', baseText, lightTints);
      check('dark', darkText, darkTints);
    }
    return out;
  };

  /** Spellings the resolver cannot see, banned outright. */
  const bannedForms = (cls: string): string[] => {
    const out: string[] = [];
    // `bg-x/30/30` matches no utility — Tailwind emits nothing for it.
    for (const m of cls.matchAll(/\S*-[\w-]+\/\d+\/\d+/g))
      out.push(`double opacity modifier: ${m[0]}`);
    // An opacity step outside Tailwind 3's scale (`bg-primary/8`) also emits
    // nothing, silently: the sidebar's active item had no tint at all.
    for (const m of cls.matchAll(COLOUR_OPACITY)) {
      if (!OPACITY_SCALE.has(Number(m[2]))) out.push(`off-scale opacity: ${m[1]}/${m[2]}`);
    }
    // Arbitrary-value role colours bypass the token form this gate measures;
    // the tokens (`bg-success/10`, `text-success-ink`) render the same hsl().
    const arb = new RegExp(`\\S*\\[hsl\\(var\\(--(${ROLE_LIST.join('|')})\\)\\)\\]\\S*`, 'g');
    for (const m of cls.matchAll(arb)) out.push(`arbitrary-value role colour: ${m[0]}`);
    return out;
  };

  const problems = (src: string): string[] =>
    classStrings(src).flatMap(cls =>
      [...pillProblems(cls), ...bannedForms(cls)].map(p => `${p} — ${cls}`)
    );

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
    expect(problems(`'bg-warning/10 p-4 text-sm text-warning'`)).toHaveLength(2); // light + dark
    expect(problems(`'bg-warning/10 p-4 text-warning-ink hover:text-warning'`)).toEqual([]);
  });

  // Known-bad fixtures: the exact strings the three issues found in source.
  it.each([
    ['2323 dark: pair', `'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info'`],
    [
      '2323 success dark pair',
      `'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success'`,
    ],
    [
      '2322 arbitrary-value pair',
      `'bg-[hsl(var(--success))]/10 border border-[hsl(var(--success))]/20 text-[hsl(var(--success))]'`,
    ],
    ['2313 double modifier', `'bg-destructive/10 text-destructive-ink dark:bg-destructive/30/30'`],
    ['alpha outside 5/10/15', `'bg-info/20 text-info dark:bg-info/40 dark:text-info'`],
    ['off-scale opacity', `'bg-primary/8 text-primary-ink'`],
    ['bare text on an off-scale tint', `'bg-primary/8 text-primary'`],
  ])('control: flags %s', (_name, src) => {
    expect(problems(src).length).toBeGreaterThan(0);
  });

  it.each([
    [`'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink'`],
    [`'bg-destructive/10 text-destructive-ink dark:bg-destructive/30'`],
    [`'bg-primary text-primary-foreground hover:bg-primary/90'`],
    [`'w-1/2 text-success border hover:bg-success/10'`],
  ])('control: passes %s', src => {
    expect(problems(src)).toEqual([]);
  });

  it('every tinted pill resolves to a readable -ink pair in both themes', () => {
    const offenders = files.flatMap(f =>
      problems(readFileSync(f, 'utf8')).map(o => `${f.slice(ADMIN.length + 1)} — ${o}`)
    );
    expect(offenders).toEqual([]);
  });
});
