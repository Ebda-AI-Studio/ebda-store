import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * iOS Safari zooms the whole page when the visitor taps a text control whose text is under 16px,
 * and does not zoom back out. DESIGN.md pins the rule: "Form input (mobile) 16px".
 *
 * A storefront control with no size class of its own is NOT 16px: it inherits its parent, and the
 * Arabic body is 15.2px on a phone (globals.css), or 14px inside a `text-sm` label. So every raw
 * `<input>`, `<select>` and `<textarea>` under apps/web/src has to carry a 16px-or-larger phone size
 * itself. This walks all of them, so a new control cannot ship without one.
 */

const ROOT = join(__dirname, '..', '..');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const GLOBALS = readFileSync(join(WEB_SRC, 'styles', 'globals.css'), 'utf8');

/** Controls the visitor cannot type in or pick from with the on-screen keyboard. */
const NON_TEXT_TYPES = /type=["'](checkbox|radio|hidden|file|range|color)["']/;

/** A phone size of 16px or more: an unprefixed Tailwind size class (a `sm:` variant does not count). */
const PHONE_16 = /(?<![\w:-])text-(base|lg|xl|[2-9]xl|\[(1[6-9]|[2-9]\d)px\])(?![\w-])/;

/**
 * Controls that are deliberately not held to the rule. Each needs a reason a reviewer can check.
 */
const EXEMPT: { file: string; marker: string; why: string }[] = [
  {
    file: 'app/contact/ContactClient.tsx',
    marker: 'id="contact-company-site"',
    why: 'spam trap: off-screen, tabIndex -1, never tapped by a person',
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== '__tests__') sourceFiles(path, out);
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/** Comments mention `<input>` in prose; they are not controls. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The opening tag that starts at `start`, up to its closing `>` (skipping `>` inside `{…}`). */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** The body of a component-layer rule in globals.css, e.g. `.search-input { @apply … }`. */
function globalRule(className: string): string {
  const m = GLOBALS.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
}

/** Tailwind's default font-size scale (the storefront theme does not redefine it), in px. */
const SCALE_PX: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
  '6xl': 60,
};

/** The px size a single font-size utility sets (`text-base`, `text-[16px]`, `text-[1rem]`), else null. */
function utilityPx(utility: string): number | null {
  const m = utility.match(/^text-(?:(xs|sm|base|lg|[2-6]?xl)|\[(\d+(?:\.\d+)?)(px|rem)\])$/);
  if (!m) return null;
  if (m[1]) return SCALE_PX[m[1]];
  return m[3] === 'rem' ? Number(m[2]) * 16 : Number(m[2]);
}

/** Class tokens out of a chunk of source (a className literal, a const's initialiser, a @apply body). */
const tokensOf = (text: string) =>
  text
    .split(/\s+/)
    .map(t => t.replace(/^[`'"(,]+|[`'",);]+$/g, ''))
    .filter(Boolean);

/**
 * The font size that APPLIES to a control on a phone (under Tailwind's `sm` 640px), from its classes:
 * - a `max-sm:`-style variant (any `max-*:`) applies on a phone and beats an unprefixed utility;
 * - otherwise the control's own unprefixed size utility (utilities layer);
 * - otherwise a size from a globals.css component rule it uses (components layer: a utility on the tag
 *   beats it, so a tag `text-sm` over `.search-input { @apply text-base }` is 14px, not 16px);
 * - a `sm:`/`md:`/... variant never applies on a phone and is ignored.
 * Two conflicting sizes in one layer count as the SMALLER one: which wins depends on stylesheet order, so the
 * check must not assume the friendly one does. Returns null when nothing sets a size (the control inherits).
 */
function phoneSizePx(utilities: string[], components: string[]): number | null {
  const pick = (tokens: string[]) => {
    const phoneVariant = tokens
      .map(t => t.match(/^max-[\w-]+:(text-.+)$/)?.[1])
      .map(t => (t ? utilityPx(t) : null))
      .filter((n): n is number => n !== null);
    if (phoneVariant.length) return Math.min(...phoneVariant);
    const plain = tokens.map(utilityPx).filter((n): n is number => n !== null);
    return plain.length ? Math.min(...plain) : null;
  };
  return pick(utilities) ?? pick(components);
}

/**
 * The classes of ONE control, by layer: its own className (a literal, or the `const NAME = '…'` the
 * className expression names, in the same file) and the globals.css rules of the plain classes it uses.
 * A className expression this cannot resolve to one class list (a ternary, a prop, a function call) is
 * reported as unresolved instead of guessed: merging every branch's text made a 16px class from one
 * branch hide a smaller (or missing) size on another.
 */
function classLayers(
  tag: string,
  src: string
): { utilities: string[]; components: string[] } | { unresolved: string } {
  let own: string[] = [];
  const expr = tag.match(/className=\{([^}]*)\}/);
  const literal = tag.match(/className="([^"]*)"/);
  if (expr) {
    const ident = expr[1].trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) return { unresolved: expr[1].trim() };
    const decl = src.match(new RegExp(`(?:const|let)\\s+${ident}\\s*=([\\s\\S]*?);\\n`));
    if (!decl || !/^\s*['"`]/.test(decl[1])) return { unresolved: ident };
    own = tokensOf(decl[1]);
  } else if (literal) {
    own = tokensOf(literal[1]);
  }
  const components = own
    .filter(cls => /^[a-z][a-z-]*$/.test(cls))
    .flatMap(cls => tokensOf(globalRule(cls).replace(/@apply/g, ' ')));
  return { utilities: own, components };
}

type Control = { where: string; tag: string; sizePx: number | null; unresolved?: string };

function controls(): Control[] {
  const found: Control[] = [];
  for (const file of sourceFiles(WEB_SRC)) {
    const src = withoutComments(readFileSync(file, 'utf8'));
    const rel = relative(WEB_SRC, file);
    const re = /<(select|input|textarea)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = openingTag(src, m.index);
      if (NON_TEXT_TYPES.test(tag)) continue;
      if (EXEMPT.some(e => e.file === rel && tag.includes(e.marker))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const layers = classLayers(tag, src);
      const where = `${rel} (<${m[1]}> #${line})`;
      if ('unresolved' in layers)
        found.push({ where, tag, sizePx: null, unresolved: layers.unresolved });
      else found.push({ where, tag, sizePx: phoneSizePx(layers.utilities, layers.components) });
    }
  }
  return found;
}

describe('storefront text controls are 16px or larger on a phone', () => {
  const all = controls();

  it('finds the controls it is meant to guard', () => {
    // A walk that finds nothing passes every assertion below. The storefront has dozens of controls.
    expect(all.length).toBeGreaterThan(20);
    expect(all.some(c => c.where.startsWith('components/demo/DemoLookBar.tsx'))).toBe(true);
    expect(all.some(c => c.where.startsWith('app/checkout/'))).toBe(true);
  });

  it('every control has a className this check can resolve to one class list', () => {
    expect(all.filter(c => c.unresolved).map(c => `${c.where}: ${c.unresolved}`)).toEqual([]);
  });

  it('every raw input, select and textarea is 16px or more at phone width', () => {
    const small = all
      .filter(c => !c.unresolved && (c.sizePx === null || c.sizePx < 16))
      .map(c => `${c.where}: ${c.sizePx === null ? 'inherits' : `${c.sizePx}px`}`);
    expect(small).toEqual([]);
  });

  it('every exemption still points at a real control', () => {
    for (const e of EXEMPT) {
      const src = readFileSync(join(WEB_SRC, e.file), 'utf8');
      expect(src.includes(e.marker), `${e.file}: ${e.marker} (${e.why})`).toBe(true);
    }
  });

  it('the shared field components the storefront forms are built from are 16px on a phone', () => {
    // The file names are capitalised on disk (Input.tsx); a lower-case path only opens on a file system that ignores case.
    for (const [file, name] of [
      ['Input', 'input'],
      ['Select', 'select'],
      ['Textarea', 'textarea'],
    ]) {
      const src = readFileSync(
        join(ROOT, 'packages', 'ui', 'src', 'components', `${file}.tsx`),
        'utf8'
      );
      const tag = openingTag(src, src.search(new RegExp(`<${name}\\b`)));
      expect(PHONE_16.test(tag), `packages/ui ${name}`).toBe(true);
    }
  });

  it('the phone size is the class that applies, not any 16px class found nearby', () => {
    const size = (own: string, comp = '') => phoneSizePx(tokensOf(own), tokensOf(comp));
    expect(size('min-h-11 text-base sm:text-sm')).toBe(16);
    expect(size('min-h-11 sm:text-base')).toBeNull(); // a wider-screen size does not apply on a phone
    expect(size('text-base max-sm:text-sm')).toBe(14); // a phone-only variant beats the plain utility
    expect(size('text-base text-sm')).toBe(14); // a conflict counts as the smaller size
    expect(size('search-input text-sm', 'text-base sm:text-sm')).toBe(14); // utilities beat a component rule
    expect(size('search-input', 'min-h-11 text-base sm:text-sm')).toBe(16); // the component rule applies alone
    expect(size('w-full text-[1rem]')).toBe(16);
    expect(size('w-full text-[15px]')).toBe(15);
    expect(size('w-full text-foreground')).toBeNull();
  });

  it('the size check tells a phone size from a wider-screen one', () => {
    expect(PHONE_16.test('min-h-11 text-base sm:text-sm')).toBe(true);
    expect(PHONE_16.test('min-h-11 text-sm')).toBe(false);
    expect(PHONE_16.test('min-h-11 sm:text-base')).toBe(false);
    expect(PHONE_16.test('min-h-11 placeholder:text-base')).toBe(false);
    expect(PHONE_16.test('min-h-11 text-[15px]')).toBe(false);
    expect(PHONE_16.test('min-h-11 text-[16px]')).toBe(true);
    expect(PHONE_16.test('w-full px-4 text-foreground')).toBe(false);
  });
});
