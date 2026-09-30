/**
 * Issue 2233 — a role colour on its own 10% tint (`bg-warning/10 text-warning`)
 * is unreadable: amber on amber measured 1.7:1, and every role failed WCAG AA
 * (4.5:1) in the light theme. Tinted pills use the `-ink` token instead.
 *
 * Gates, per app, each measured from THAT app's own globals.css:
 *  (1) each `-ink` meets 4.5:1 against its tint over the card, in BOTH themes;
 *  (2) every class string resolves to a readable pair — at rest on its tint,
 *      on its `hover:` tint (issue 2332), and bare role text on the plain card
 *      (issue 2332) — 4.5:1 for text, 3:1 for an icon (a fixed h-*+w-* box);
 *  (3) no spelling Tailwind silently drops: a double opacity modifier
 *      (`/30/30`) or an off-scale step (`/8`).
 *
 * Scope (issues 2341, 2342, 2349): admin and orders get all three; the
 * storefront (apps/web) and packages/ui get (3) only — a class that emits no
 * CSS is a bug on any surface, but re-colouring storefront text is a visible
 * change the owner has not approved (pecannbee must not change; Ruling YWA-TXT-1).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

type Theme = 'light' | 'dark';
type HSL = [number, number, number];
const ROLES = ['primary', 'success', 'warning', 'info', 'destructive'] as const;
type Role = (typeof ROLES)[number];
/** Roles whose BARE text is checked on the plain surface. `primary` is the
 *  brand orange used for every admin link — re-colouring it is an owner call
 *  (Ruling YWA-TXT-1), so it is checked on tints only. */
const SURFACE_ROLES: readonly Role[] = ['success', 'warning', 'info', 'destructive'];

interface AppSpec {
  name: string;
  root: string;
  css?: string; // relative to root; present = contrast gates apply
}
const REPO = resolve(__dirname, '../..');
const APPS: AppSpec[] = [
  { name: 'admin', root: join(REPO, 'apps/admin'), css: 'src/styles/globals.css' },
  { name: 'orders', root: join(REPO, 'apps/orders'), css: 'src/app/globals.css' },
  { name: 'web', root: join(REPO, 'apps/web') },
  { name: 'ui', root: join(REPO, 'packages/ui') },
];

function tokensFrom(cssPath: string): (name: string, theme: Theme) => HSL {
  const css = readFileSync(cssPath, 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('}', start));
  };
  const light = block(':root');
  const dark = block('.dark');
  return (name, theme) => {
    const read = (b: string) =>
      new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(b);
    // The dark block only overrides some tokens; the rest inherit :root.
    const m = (theme === 'dark' && read(dark)) || read(light);
    if (!m) throw new Error(`token --${name} not found in ${cssPath}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
}

function rgb([h, s, l]: HSL): number[] {
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

const TINT_MAX = 40; // above this the class is a solid fill, not a tint
const OPACITY_SCALE = new Set(Array.from({ length: 21 }, (_, i) => i * 5));
const COLOUR_OPACITY =
  /(?<![\w/-])((?:[\w-]+:)*(?:bg|text|border|ring|from|via|to|fill|stroke|outline|divide|shadow|decoration|placeholder)-[a-z][\w-]*)\/(\d+)(?![\w/.])/g;

const classStrings = (src: string): string[] =>
  [...src.matchAll(/(["'`])([^"'`\n]*)\1/g)].map(m => m[2]);

/** Spellings Tailwind drops without a word, banned outright on EVERY app. */
function droppedForms(cls: string): string[] {
  const out: string[] = [];
  // `bg-x/30/30` matches no utility — Tailwind emits nothing for it.
  for (const m of cls.matchAll(/\S*-[\w-]+\/\d+\/\d+/g))
    out.push(`double opacity modifier: ${m[0]}`);
  // An opacity step outside Tailwind 3's scale (`bg-primary/8`) also emits
  // nothing, silently: the sidebar's active item had no tint at all.
  for (const m of cls.matchAll(COLOUR_OPACITY)) {
    if (!OPACITY_SCALE.has(Number(m[2]))) out.push(`off-scale opacity: ${m[1]}/${m[2]}`);
  }
  return out;
}

/** Contrast apps only: arbitrary-value role colours bypass the token form the
 *  contrast gate measures (they do emit CSS, so the storefront is not gated). */
function bannedForms(cls: string): string[] {
  const out = droppedForms(cls);
  const arb = new RegExp(`\\S*\\[hsl\\(var\\(--(${ROLES.join('|')})\\)\\)\\]\\S*`, 'g');
  for (const m of cls.matchAll(arb)) out.push(`arbitrary-value role colour: ${m[0]}`);
  return out;
}

/**
 * Every contrast problem in one class string, per theme, in three states:
 * at rest on its own tint (or the card), and on its `hover:` tint. The text
 * that applies is resolved the way Tailwind resolves it (`dark:hover:` →
 * `dark:` → `hover:` → base), and measured against THIS app's tokens.
 */
function contrastProblems(cls: string, token: (n: string, t: Theme) => HSL): string[] {
  const out: string[] = [];
  const tokens = cls.split(/\s+/);
  // A fixed square box is an icon: non-text contrast (3:1) applies.
  const icon =
    tokens.some(t => /^(?:h-\d|h-\[|size-)/.test(t)) &&
    tokens.some(t => /^(?:w-\d|w-\[|size-)/.test(t));
  const need = icon ? 3 : 4.5;
  const alpha = (variant: string, r: Role): number | undefined => {
    for (const t of tokens) {
      const m = new RegExp(`^${variant}bg-${r}/(\\d+)$`).exec(t);
      if (m && Number(m[1]) <= TINT_MAX) return Number(m[1]);
    }
    return undefined;
  };
  const text = (variant: string, r: Role): 'bare' | 'ink' | undefined => {
    for (const t of tokens) {
      if (t === `${variant}text-${r}-ink`) return 'ink';
      if (t === `${variant}text-${r}` || new RegExp(`^${variant}text-${r}/\\d+$`).test(t))
        return 'bare';
    }
    return undefined;
  };
  const measure = (theme: Theme, r: Role, t: 'bare' | 'ink', a: number | undefined) => {
    const card = rgb(token('card', theme));
    const bg =
      a === undefined
        ? card
        : rgb(token(r, theme)).map((v, i) => (v * a) / 100 + card[i] * (1 - a / 100));
    return ratio(rgb(token(t === 'ink' ? `${r}-ink` : r, theme)), bg);
  };
  for (const r of ROLES) {
    const states: Array<[Theme, string, 'bare' | 'ink' | undefined, number | undefined]> = [
      ['light', 'rest', text('', r), alpha('', r)],
      ['dark', 'rest', text('dark:', r) ?? text('', r), alpha('dark:', r) ?? alpha('', r)],
    ];
    const hoverLight = alpha('hover:', r);
    const hoverDark = alpha('dark:hover:', r) ?? hoverLight;
    if (hoverLight !== undefined)
      states.push(['light', 'hover', text('hover:', r) ?? text('', r), hoverLight]);
    if (hoverDark !== undefined)
      states.push([
        'dark',
        'hover',
        text('dark:hover:', r) ?? text('dark:', r) ?? text('hover:', r) ?? text('', r),
        hoverDark,
      ]);
    for (const [theme, state, t, a] of states) {
      if (!t) continue;
      // Bare `primary` text is checked on a RESTING tint (a pill) only — on the
      // plain surface and under a hover tint it is the brand link colour,
      // an owner call (Ruling YWA-TXT-1). The other roles are checked everywhere.
      if (t === 'bare' && !SURFACE_ROLES.includes(r) && (a === undefined || state === 'hover'))
        continue;
      const c = measure(theme, r, t, a);
      if (c < need) {
        const where = a === undefined ? 'the card' : `its ${a}% tint`;
        out.push(
          `${theme} ${state}: ${t === 'ink' ? `${r}-ink` : `bare text-${r}`}${icon ? ' (icon)' : ''} on ${where} = ${c.toFixed(2)}:1`
        );
      }
    }
  }
  return out;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  walk(join(root, 'src'));
  return files;
}

const admin = APPS[0];
const adminToken = tokensFrom(join(admin.root, admin.css!));
const problems = (src: string, token = adminToken): string[] =>
  classStrings(src).flatMap(cls =>
    [...contrastProblems(cls, token), ...bannedForms(cls)].map(p => `${p} — ${cls}`)
  );

for (const app of APPS.filter(a => a.css)) {
  const token = tokensFrom(join(app.root, app.css!));
  describe(`${app.name}: tinted-pill ink contrast (issues 2233, 2341)`, () => {
    for (const theme of ['light', 'dark'] as const) {
      it.each(ROLES)(
        `${theme}: %s-ink on its 5/10/15/20%% tints and the card is >= 4.5:1`,
        role => {
          const card = rgb(token('card', theme));
          for (const a of [0, 0.05, 0.1, 0.15, 0.2]) {
            const tint = rgb(token(role, theme)).map((v, i) => v * a + card[i] * (1 - a));
            expect(ratio(rgb(token(`${role}-ink`, theme)), tint), `${a}`).toBeGreaterThanOrEqual(
              4.5
            );
          }
        }
      );
    }

    it('control: the bare role colour really does fail on the light warning tint', () => {
      const card = rgb(token('card', 'light'));
      const tint = rgb(token('warning', 'light')).map((v, i) => v * 0.1 + card[i] * 0.9);
      expect(ratio(rgb(token('warning', 'light')), tint)).toBeLessThan(3);
    });
  });
}

describe('the contrast detector (controls)', () => {
  it('flags a non-adjacent pair and passes the ink form', () => {
    expect(problems(`'bg-warning/10 p-4 text-sm text-warning'`).length).toBeGreaterThanOrEqual(1);
    expect(problems(`'bg-warning/10 p-4 text-warning-ink hover:text-warning-ink'`)).toEqual([]);
  });

  // Known-bad fixtures: the exact strings the issues found in source.
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
    ['2332 bare role text on the card', `'mt-1 text-sm text-destructive'`],
    ['2332 bare warning text on the card', `'text-xs text-warning'`],
    ['2332 hover tint under bare text', `'w-1/2 text-success border hover:bg-success/10'`],
    [
      '2332 hover text swap',
      `'text-muted-foreground hover:text-destructive hover:bg-destructive/10'`,
    ],
    ['2332 role text with opacity', `'text-xs text-destructive/80'`],
    ['2332 warning icon (under 3:1)', `'h-4 w-4 text-warning'`],
    ['2342 off-scale via stop', `'bg-gradient-to-br from-primary/15 via-primary/8 to-muted'`],
  ])('flags %s', (_name, src) => {
    expect(problems(src).length).toBeGreaterThan(0);
  });

  it.each([
    [`'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink'`],
    [`'bg-destructive/10 text-destructive-ink dark:bg-destructive/30'`],
    [`'bg-primary text-primary-foreground hover:bg-primary/90'`],
    [`'w-1/2 text-success-ink border hover:bg-success/10'`],
    [`'text-muted-foreground hover:text-destructive-ink hover:bg-destructive/10'`],
    [`'h-4 w-4 text-destructive'`], // icon: 4.38:1 >= 3:1
    [`'text-primary hover:underline'`], // brand links: Ruling YWA-TXT-1
  ])('passes %s', src => {
    expect(problems(src)).toEqual([]);
  });
});

for (const app of APPS) {
  const files = sourceFiles(app.root);
  const token = app.css ? tokensFrom(join(app.root, app.css)) : null;
  describe(`${app.name}: no class Tailwind drops${token ? ', no unreadable role colour' : ''}`, () => {
    it('finds files to scan (control)', () => expect(files.length).toBeGreaterThan(10));

    it(
      token
        ? 'every role colour resolves to a readable pair, at rest and on hover, in both themes'
        : 'no double or off-scale opacity modifier',
      () => {
        const offenders = files.flatMap(f =>
          classStrings(readFileSync(f, 'utf8')).flatMap(cls =>
            [
              ...(token
                ? [...contrastProblems(cls, token), ...bannedForms(cls)]
                : droppedForms(cls)),
            ].map(p => `${f.slice(app.root.length + 1)} — ${p} — ${cls}`)
          )
        );
        expect(offenders).toEqual([]);
      }
    );
  });
}
