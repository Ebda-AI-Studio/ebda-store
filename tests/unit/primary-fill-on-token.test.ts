/**
 * K-02 (Qamar taste audit 2026-10-15, quality-bar § 3): a fill is always paired
 * with its on-token. `bg-primary text-white` sat on 33+ storefront elements; on a
 * light primary (Lookbook) white measures 2.16:1. `--primary-foreground` is the
 * store's own on-primary ink, so `bg-primary` ⇒ `text-primary-foreground`.
 *
 * One element = one `className` expression (every string literal inside it,
 * ternary arms and cn() arguments included) or one CSS `@apply`. Within it, the
 * same variant prefix (`''`, `hover:`, `group-hover:` …) must not carry both a
 * `bg-primary` fill and `text-white`. Coloured primary glows (`shadow-primary/NN`)
 * on those elements went too, and are banned on the shared storefront the same way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import {
  DEFAULT_THEME,
  TEMPLATES,
  contrastRatio,
  getTemplateTheme,
  themeToCssVars,
  type StoreTheme,
} from '@ebda/shared';

const ROOT = join(__dirname, '../..');
const SCAN = [join(ROOT, 'apps/web/src'), join(ROOT, 'packages/ui/src')];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|ts|css)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

/**
 * Every className expression's text, and every @apply. Parsed, not scanned: a TSX file through the
 * TypeScript parser (every JSX `className` attribute: a brace or quote inside a string cannot cut an
 * expression short, and a comment that mentions `className=` is not one), a CSS file through postcss
 * (every `@apply` at-rule; comments are not nodes).
 */
export function elements(src: string, kind: 'tsx' | 'css'): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  if (kind === 'css') {
    postcss.parse(src).walkAtRules('apply', rule => {
      out.push({ text: rule.params, at: rule.source?.start?.offset ?? 0 });
    });
    return out;
  }
  const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n: ts.Node): void => {
    if (
      ts.isJsxAttribute(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'className' &&
      n.initializer
    ) {
      const init = n.initializer;
      out.push({
        // a plain attribute ("…") is its class list; a {…} expression keeps its source text
        text: ts.isStringLiteral(init) ? init.text : init.getText(sf),
        at: init.getStart(sf),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * A `text-*` class that is NOT a colour: size, alignment, wrapping, an
 * arbitrary length. Anything else (`text-white`, `text-black`, `text-[#160b03]`,
 * `text-gray-900`, `text-foreground` …) hard-codes an ink.
 */
const TEXT_NOT_COLOUR =
  /^text-(?:xs|sm|base|lg|[2-9]?xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|\[[\d.]+(?:px|rem|em|%)\]|\[length:[^\]]+\]|\[clamp\([^\]]+\]|\[min\([^\]]+\]|\[calc\([^\]]+\])$/;

/**
 * The pairing on one element: at the same variant prefix, an opaque
 * `bg-primary` fill (`bg-primary`, `bg-primary/80`+) with any text ink other
 * than `text-primary-foreground`. A tint (`bg-primary/10`) is not a fill.
 */
export function pairs(text: string): string[] {
  // A plain attribute ("…") is one class list. A {…} expression is split into its
  // string literals: the unconditional ones always apply, and each conditional
  // one (a ternary arm or an `&&` operand) applies together with them, but
  // never with its sibling arm.
  if (!/['"`]/.test(text)) return pairsOf(text);
  const lits = literals(text, false);
  const always = lits
    .filter(l => !l.cond)
    .map(l => l.body)
    .join(' ');
  const out = new Set(pairsOf(always));
  for (const l of lits.filter(x => x.cond))
    for (const p of pairsOf(`${always} ${l.body}`)) out.add(p);
  return [...out];
}

/**
 * The string literals of an expression, each marked conditional when it is a
 * ternary arm or an `&&`/`||` operand. A template literal's static text is a
 * literal of its own; each `${…}` inside it is parsed the same way.
 */
function literals(expr: string, inherited: boolean): Array<{ body: string; cond: boolean }> {
  const out: Array<{ body: string; cond: boolean }> = [];
  let i = 0;
  while (i < expr.length) {
    const q = expr[i];
    if (q !== "'" && q !== '"' && q !== '`') {
      i++;
      continue;
    }
    const cond = inherited || /(?:\?|:|&&|\|\|)$/.test(expr.slice(0, i).trimEnd());
    if (q !== '`') {
      const end = expr.indexOf(q, i + 1);
      if (end === -1) break; // an apostrophe in prose, not a literal
      out.push({ body: expr.slice(i + 1, end), cond });
      i = end + 1;
      continue;
    }
    // template literal: static text + ${…} holes
    let j = i + 1;
    let stat = '';
    while (j < expr.length && expr[j] !== '`') {
      if (expr[j] === '$' && expr[j + 1] === '{') {
        let depth = 1;
        let k = j + 2;
        for (; k < expr.length && depth; k++) {
          if (expr[k] === '{') depth++;
          else if (expr[k] === '}') depth--;
        }
        out.push(...literals(expr.slice(j + 2, k - 1), cond));
        stat += ' ';
        j = k;
      } else stat += expr[j++];
    }
    out.push({ body: stat, cond });
    i = j + 1;
  }
  return out;
}

function pairsOf(text: string): string[] {
  const classes = text.split(/[\s'"`{}(),?]+/).filter(Boolean);
  const byPrefix = new Map<string, Set<string>>();
  for (const c of classes) {
    const i = c.lastIndexOf(':');
    const prefix = i === -1 ? '' : c.slice(0, i + 1);
    const base = (i === -1 ? c : c.slice(i + 1)).replace(/^!/, '');
    const fill = base.match(/^bg-primary(?:\/(\d+))?$/);
    const kind =
      fill && (!fill[1] || Number(fill[1]) >= 80)
        ? 'fill'
        : base.startsWith('text-') &&
            base !== 'text-primary-foreground' &&
            !TEXT_NOT_COLOUR.test(base)
          ? 'ink'
          : null;
    if (!kind) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
    byPrefix.get(prefix)!.add(kind);
  }
  return [...byPrefix].filter(([, k]) => k.has('fill') && k.has('ink')).map(([p]) => p || 'base');
}

/**
 * Sanctioned exceptions, each with its reason. The platform landing (ebda.app's
 * own marketing header) paints Ebda's brand orange, not a store primary, with
 * a fixed dark ink that measures AA on it.
 */
const ALLOW: Record<string, string> = {
  'apps/web/src/components/landing/LandingHeader.tsx':
    "platform marketing: Ebda's own orange with a fixed AA ink, not a store theme",
};

const files = SCAN.flatMap(walk);
const kindOf = (f: string): 'tsx' | 'css' => (f.endsWith('.css') ? 'css' : 'tsx');
const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length;

describe('K-02: bg-primary is paired with text-primary-foreground', () => {
  it('scans the storefront and packages/ui', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no element pairs a primary fill with white text', () => {
    const hits = files
      .filter(f => !ALLOW[relative(ROOT, f)])
      .flatMap(f => {
        const src = readFileSync(f, 'utf8');
        return elements(src, kindOf(f)).flatMap(e =>
          pairs(e.text).map(p => `${relative(ROOT, f)}:${lineOf(src, e.at)} (${p})`)
        );
      });
    expect(hits).toEqual([]);
  });

  // Shared storefront code only: a template's own components are skin identity, and the look
  // tokens that govern them are W2.
  const SKIN = /apps\/web\/src\/templates\/(?:base|dahab|qamar|souq|jasmine|lamma)\//;
  it('no coloured primary glow on a shared storefront element', () => {
    const hits = files
      .filter(f => !SKIN.test(f))
      .flatMap(f => {
        const src = readFileSync(f, 'utf8');
        return elements(src, kindOf(f))
          .filter(e => /(?:^|[\s'"`:])shadow-primary\/\d+/.test(e.text))
          .map(e => `${relative(ROOT, f)}:${lineOf(src, e.at)}`);
      });
    expect(hits).toEqual([]);
  });

  it('the matcher catches the old shapes and spares the on-token (self-test)', () => {
    const t = (s: string) =>
      elements(s, s.includes('@apply') ? 'css' : 'tsx').flatMap(e => pairs(e.text));
    expect(t(`<a className="bg-primary text-white" />`)).toEqual(['base']);
    expect(t(`<a className={cn('h-10 bg-primary px-4', 'text-white')} />`)).toEqual(['base']);
    expect(t("<a className={`x ${on ? 'bg-primary text-white' : 'bg-muted'}`} />")).toEqual([
      'base',
    ]);
    expect(t(`<a className="hover:bg-primary hover:text-white" />`)).toEqual(['hover:']);
    expect(t(`.btn { @apply bg-primary text-white; }`)).toEqual(['base']);
    expect(t(`<a className="bg-primary/90 text-white" />`)).toEqual(['base']);
    expect(t(`<a className="bg-primary text-primary-foreground" />`)).toEqual([]);
    expect(
      t(`<a className="bg-gray-950 text-white hover:bg-primary hover:text-primary-foreground" />`)
    ).toEqual([]);
    expect(t(`<a className="bg-primary-foreground text-white" />`)).toEqual([]);
    // Any hard-coded ink on the fill, not just white (review M2).
    expect(t(`<a className="bg-primary text-black" />`)).toEqual(['base']);
    expect(t(`<a className="bg-primary text-[#160b03]" />`)).toEqual(['base']);
    expect(t(`<a className="bg-primary text-gray-900 text-sm" />`)).toEqual(['base']);
    expect(t(`<a className="bg-primary text-primary-foreground text-sm text-center" />`)).toEqual(
      []
    );
    expect(t(`<a className="bg-primary/10 text-primary" />`)).toEqual([]);
    // A brace inside a string cannot cut the expression short (a char scanner lost the tail here).
    expect(t("<a className={`${'}'} bg-primary text-white`} />")).toEqual(['base']);
    // Ternary arms are separate states; a base class joins every arm.
    expect(
      t(
        "<a className={on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'} />"
      )
    ).toEqual([]);
    expect(t("<a className={cn('px-2 text-white', on ? 'bg-primary' : 'bg-muted')} />")).toEqual([
      'base',
    ]);
  });
});

/* ── The token pair itself must read (review I1) ─────────────────────────── */

const hsl = (triplet: string) => `hsl(${triplet})`;
function primaryPair(theme: StoreTheme): number {
  const v = themeToCssVars(theme);
  return contrastRatio(hsl(v['--primary']), hsl(v['--primary-foreground']));
}
/** hex → bare "H S% L%" (how the admin stores a picked colour). */
function hexToTriplet(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(x => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(h * 60 + 360) % 360;
  return `${h} ${(sat * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
}

describe('K-02: the primary fill and its ink read at AA', () => {
  it('the platform default (DEFAULT_THEME) ≥ 4.5', () => {
    expect(primaryPair(DEFAULT_THEME)).toBeGreaterThanOrEqual(4.5);
  });

  for (const tpl of TEMPLATES)
    it(`the ${tpl.id} skin default ≥ 4.5`, () => {
      expect(primaryPair(getTemplateTheme(tpl.id))).toBeGreaterThanOrEqual(4.5);
    });

  // Merchant primaries saved with the template's white ink (or black), the
  // shape every legacy store row has. #FF6F00 is the audit's case.
  const MERCHANT = [
    '#FF6F00',
    '#FFD400',
    '#F59E0B',
    '#2563EB',
    '#7C3AED',
    '#16A34A',
    '#E11D48',
    '#F5F5F5',
    '#111111',
  ];
  for (const hex of MERCHANT)
    for (const ink of ['0 0% 100%', '0 0% 0%'])
      it(`merchant primary ${hex} saved with ink ${ink} ≥ 4.5`, () => {
        const theme = { ...DEFAULT_THEME, primaryColor: hexToTriplet(hex), primaryForeground: ink };
        expect(primaryPair(theme)).toBeGreaterThanOrEqual(4.5);
      });

  it('a stored ink that already reads is kept verbatim', () => {
    const theme = {
      ...DEFAULT_THEME,
      primaryColor: '222 47% 11%',
      primaryForeground: '40 50% 95%',
    };
    // (normalised through hex, so compare the hue family, not the exact digits)
    const ink = themeToCssVars(theme)['--primary-foreground'];
    expect(ink).not.toBe('0 0% 0%');
    expect(ink).not.toBe('0 0% 100%');
    expect(ink).toMatch(/^3\d|^4\d/);
  });

  it('the globals.css fallbacks (:root and .dark) ≥ 4.5', () => {
    // postcss rules, not a text window: every rule whose selector is exactly `:root` / `.dark`
    // that declares the pair is measured (a first match of the selector text could be another rule).
    const root = postcss.parse(readFileSync(join(ROOT, 'apps/web/src/styles/globals.css'), 'utf8'));
    for (const sel of [':root', '.dark']) {
      let measured = 0;
      root.walkRules(sel, rule => {
        const decl = (n: string) => {
          let v: string | undefined;
          rule.walkDecls(`--${n}`, d => void (v = d.value.trim()));
          return v;
        };
        const [fill, ink] = [decl('primary'), decl('primary-foreground')];
        if (!fill || !ink) return;
        measured++;
        expect(contrastRatio(hsl(fill), hsl(ink)), sel).toBeGreaterThanOrEqual(4.5);
      });
      expect(measured, `${sel} declares the primary pair`).toBeGreaterThan(0);
    }
  });
});
