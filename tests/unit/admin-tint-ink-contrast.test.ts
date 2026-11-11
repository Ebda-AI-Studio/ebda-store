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
 *  (4) no raw neutral palette utility (`text-gray-900`, `bg-slate-100`, …):
 *      it does not follow the theme, so dark mode rendered #111827 on the
 *      #0b101c card at ~1:1 (issue 2372). Use the semantic tokens —
 *      `text-foreground`, `text-muted-foreground`, `border-border`, `bg-muted`,
 *      and `text-muted-ink` for text on a SOLID `bg-muted` (the grey pill).
 *      Gradient stops (`from-neutral-800`) are exempt: they paint swatches.
 *
 *  (5) no raw chromatic text (`text-green-800`) in the same class string as a
 *      THEMED surface (`bg-card`, `bg-background`, `bg-popover`): the surface
 *      turns dark and the fixed text does not — green-800 on the dark card is
 *      2.66:1 (issue 2381). Raw text on a raw LIGHT tint (`bg-green-100
 *      text-green-700`) is theme-blind but readable, so it is not flagged here.
 *
 * Scope (issues 2341, 2342, 2349, 2380): admin and orders get all five;
 * packages/ui gets (3) only. EXCEPT: a packages/ui component that admin or
 * orders imports renders on that app's surface, so it gets all five, measured
 * with that app's tokens (issue 2380 — the source-directory scope reported
 * green on `<Label>`'s text-gray-700 while it rendered in the admin dark theme
 * at ~1.8:1).
 * The storefront (apps/web, issue 2349 storefront half, owner option A
 * 2026-09-30) gets (1)-(3) for the four STATUS roles — `primary` is the
 * merchant's brand colour (Ruling YWA-TXT-1) — measured from the no-theme
 * fallback in its globals.css; a store's own inks are derived from its palette
 * and gated in tests/unit/storefront-status-ink.test.ts, and demo-store keeps
 * the old colours through `theme.legacyBannerContrast` (data, Ruling BC-1).
 * (4) and (5) are not applied to the storefront (Ruling BC-1).
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
  /** Roles the contrast gates measure (default: all five). */
  roles?: readonly Role[];
  /** false = skip gates (4) and (5), the raw-palette bans (default true). */
  paletteBans?: boolean;
  /** Class strings that are graphics, not message text, each with its reason. */
  exempt?: ReadonlyArray<{ file: string; cls: string; why: string }>;
}
const REPO = resolve(__dirname, '../..');
const APPS: AppSpec[] = [
  { name: 'admin', root: join(REPO, 'apps/admin'), css: 'src/styles/globals.css' },
  { name: 'orders', root: join(REPO, 'apps/orders'), css: 'src/app/globals.css' },
  {
    name: 'web',
    root: join(REPO, 'apps/web'),
    css: 'src/styles/globals.css',
    roles: SURFACE_ROLES,
    paletteBans: false,
    // Ruling BC-1: rating stars and the wishlist heart are graphics in the
    // role colour, not message text; the footers' newsletter error sits on a
    // merchant-coloured footer the root ink is not measured against.
    exempt: [
      ...['src/components/ReviewSection.tsx'].flatMap(file => [
        { file, cls: 'text-[hsl(var(--warning))]', why: 'rating star glyph' },
      ]),
      {
        file: 'src/templates/shared/TestimonialRow.tsx',
        cls: 'text-warning',
        why: 'rating star glyph',
      },
      {
        file: 'src/templates/shared/StorefrontProductCard.tsx',
        cls: 'text-destructive',
        why: 'filled wishlist heart',
      },
    ],
  },
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
const RAW_NEUTRAL =
  /(?<![\w-])((?:[\w-]+:)*(?:text|bg|border|divide|ring|placeholder|outline|fill|stroke)-(?:gray|slate|zinc|neutral|stone)-\d+(?:\/\d+)?)(?![\w/-])/g;

const RAW_CHROMATIC_TEXT =
  /(?<![\w-])((?:[\w-]+:)*text-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+(?:\/\d+)?)(?![\w/-])/g;
const THEMED_SURFACE = /(?<![\w:-])bg-(?:card|background|popover)(?![\w/-])/;

/** `paletteBans` = gates (4) and (5); the storefront opts out (Ruling BC-1). */
function bannedForms(cls: string, roles: readonly Role[] = ROLES, paletteBans = true): string[] {
  const out = droppedForms(cls);
  if (paletteBans) {
    for (const m of cls.matchAll(RAW_NEUTRAL))
      out.push(`raw neutral palette utility (use a semantic token): ${m[1]}`);
    if (THEMED_SURFACE.test(cls))
      for (const m of cls.matchAll(RAW_CHROMATIC_TEXT))
        out.push(`raw palette text on a themed surface (use a role -ink): ${m[1]}`);
  }
  const arb = new RegExp(`\\S*\\[hsl\\(var\\(--(${roles.join('|')})\\)\\)\\]\\S*`, 'g');
  for (const m of cls.matchAll(arb)) out.push(`arbitrary-value role colour: ${m[0]}`);
  return out;
}

/**
 * Every contrast problem in one class string, per theme, in three states:
 * at rest on its own tint (or the card), and on its `hover:` tint. The text
 * that applies is resolved the way Tailwind resolves it (`dark:hover:` →
 * `dark:` → `hover:` → base), and measured against THIS app's tokens.
 */
function contrastProblems(
  cls: string,
  token: (n: string, t: Theme) => HSL,
  roles: readonly Role[] = ROLES
): string[] {
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
  for (const r of roles) {
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
      it.each(app.roles ?? ROLES)(
        `${theme}: %s-ink on its tints and the card is >= 4.5:1`,
        role => {
          const card = rgb(token('card', theme));
          // The storefront's inks are derived for tints up to 30% (statusInkVars).
          const alphas =
            app.name === 'web' ? [0, 0.05, 0.1, 0.15, 0.2, 0.3] : [0, 0.05, 0.1, 0.15, 0.2];
          for (const a of alphas) {
            const tint = rgb(token(role, theme)).map((v, i) => v * a + card[i] * (1 - a));
            expect(ratio(rgb(token(`${role}-ink`, theme)), tint), `${a}`).toBeGreaterThanOrEqual(
              4.5
            );
          }
        }
      );
    }

    if (app.name === 'admin') {
      // Issue 2372: the grey pill. `muted-foreground` is 4.32:1 on a solid
      // `bg-muted` in light, so text there uses `muted-ink`.
      it.each(['light', 'dark'] as const)(
        '%s: muted-ink on bg-muted and on the card is >= 4.5:1',
        theme => {
          const ink = rgb(token('muted-ink', theme));
          expect(ratio(ink, rgb(token('muted', theme)))).toBeGreaterThanOrEqual(4.5);
          expect(ratio(ink, rgb(token('card', theme)))).toBeGreaterThanOrEqual(4.5);
        }
      );
      it('control: muted-foreground really does fail on a solid bg-muted in light', () => {
        expect(
          ratio(rgb(token('muted-foreground', 'light')), rgb(token('muted', 'light')))
        ).toBeLessThan(4.5);
      });
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
    ['2372 raw gray text', `'font-medium text-gray-900'`],
    ['2372 raw gray border + text', `'rounded-lg border border-gray-200 text-gray-400'`],
    ['2372 raw gray under a dark: variant', `'bg-muted dark:bg-gray-800'`],
    ['2372 raw slate pill', `'bg-slate-100 text-slate-600'`],
    ['2372 raw gray hover', `'text-muted-ink hover:bg-gray-100'`],
    ['2381 raw green on the themed card', `'border-green-200 bg-card text-green-800'`],
    ['2381 raw text on the page background', `'bg-background text-red-700'`],
    ['2380 the old @ebda/ui Label', `'text-sm font-medium text-gray-700'`],
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
    [`'bg-muted text-muted-ink border-border'`], // the grey pill, issue 2372
    [`'bg-gradient-to-br from-neutral-800 to-neutral-900'`], // a swatch, not text
    [`'bg-green-100 text-green-700'`], // forced light tint: theme-blind but readable
    [`'border-success/30 bg-success/10 text-success-ink'`], // the 2381 fix
    [`'text-sm font-medium text-foreground'`], // the 2380 fix
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
        const offenders = files.flatMap(f => {
          const rel = f.slice(app.root.length + 1);
          return classStrings(readFileSync(f, 'utf8'))
            .filter(cls => !app.exempt?.some(e => e.file === rel && e.cls === cls))
            .flatMap(cls =>
              [
                ...(token
                  ? [
                      ...contrastProblems(cls, token, app.roles),
                      ...bannedForms(cls, app.roles, app.paletteBans ?? true),
                    ]
                  : droppedForms(cls)),
              ].map(p => `${rel} — ${p} — ${cls}`)
            );
        });
        expect(offenders).toEqual([]);
      }
    );

    it('every exemption still matches a class string (no stale allow-list)', () => {
      for (const e of app.exempt ?? []) {
        const src = readFileSync(join(app.root, e.file), 'utf8');
        expect(classStrings(src), `${e.file}: ${e.why}`).toContain(e.cls);
      }
    });
  });
}

/**
 * Issue 2380: packages/ui is exempt from (4)/(5) as a directory, but admin and
 * orders compile it (admin's tailwind content glob includes packages/ui) and
 * render the components they import on their own themed surfaces. Scope by
 * RENDER SURFACE: every ui component file an app imports gets that app's full
 * gate, measured with that app's tokens. Storefront-only components
 * (ProductBadge, Rating) stay exempt under Ruling YWA-TXT-1.
 */
const UI = APPS.find(a => a.name === 'ui')!;
const uiExports = (file: string): string[] => {
  const src = readFileSync(file, 'utf8');
  const names = [
    ...[...src.matchAll(/export\s+(?:const|function|class)\s+(\w+)/g)].map(m => m[1]),
    ...[...src.matchAll(/export\s*\{([^}]*)\}/g)].flatMap(m =>
      m[1].split(',').map(n =>
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim()
      )
    ),
  ];
  return names.filter(Boolean);
};
const importedFromUi = (root: string): Set<string> =>
  new Set(
    sourceFiles(root).flatMap(f =>
      [
        ...readFileSync(f, 'utf8').matchAll(
          /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@ebda\/ui'/g
        ),
      ].flatMap(m =>
        m[1].split(',').map(n =>
          n
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]
            .trim()
        )
      )
    )
  );

for (const app of APPS.filter(a => a.css)) {
  const token = tokensFrom(join(app.root, app.css!));
  const used = importedFromUi(app.root);
  const rendered = sourceFiles(UI.root).filter(f => uiExports(f).some(n => used.has(n)));
  // Admin's own Button replaced the @ebda/ui one (Ruling ADM-BTN-1); its variants face the same gate.
  if (app.name === 'admin') rendered.push(join(app.root, 'src/components/ui/Button.tsx'));
  describe(`${app.name}: the packages/ui components it renders (issue 2380)`, () => {
    // Control: admin renders its own Button and imports Label, so the scan cannot be vacuous
    // there. Orders imports nothing from @ebda/ui today (0 files is correct).
    it('finds the components it imports (control)', () => {
      if (app.name === 'admin') {
        expect(rendered.some(f => f.endsWith('Button.tsx'))).toBe(true);
        expect(rendered.some(f => f.endsWith('Label.tsx'))).toBe(true);
      } else if (used.size > 0) {
        expect(rendered.length).toBeGreaterThan(0);
      }
    });

    it("every imported ui component passes this app's full gate", () => {
      const offenders = rendered.flatMap(f =>
        classStrings(readFileSync(f, 'utf8')).flatMap(cls =>
          [
            ...contrastProblems(cls, token, app.roles),
            ...bannedForms(cls, app.roles, app.paletteBans ?? true),
          ].map(p => `${f.slice(UI.root.length + 1)} — ${p} — ${cls}`)
        )
      );
      expect(offenders).toEqual([]);
    });
  });
}
