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

/**
 * Everything that decides the control's classes: the tag itself, any `const NAME = '…'` in the same
 * file that the tag's className names, and the globals.css rule of any plain class it uses.
 */
function classSources(tag: string, src: string): string {
  let text = tag;
  const expr = tag.match(/className=\{([^}]*)\}/);
  if (expr) {
    for (const ident of expr[1].match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
      const decl = src.match(new RegExp(`(?:const|let)\\s+${ident}\\s*=([\\s\\S]*?);\\n`));
      if (decl) text += ` ${decl[1]}`;
    }
  }
  const literal = tag.match(/className="([^"]*)"/);
  if (literal) {
    for (const cls of literal[1].split(/\s+/)) {
      if (/^[a-z][a-z-]*$/.test(cls)) text += ` ${globalRule(cls)}`;
    }
  }
  return text;
}

type Control = { where: string; tag: string; classes: string };

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
      found.push({ where: `${rel} (<${m[1]}> #${line})`, tag, classes: classSources(tag, src) });
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

  it('every raw input, select and textarea carries its own phone size of 16px or more', () => {
    const missing = all.filter(c => !PHONE_16.test(c.classes)).map(c => c.where);
    expect(missing).toEqual([]);
  });

  it('every exemption still points at a real control', () => {
    for (const e of EXEMPT) {
      const src = readFileSync(join(WEB_SRC, e.file), 'utf8');
      expect(src.includes(e.marker), `${e.file}: ${e.marker} (${e.why})`).toBe(true);
    }
  });

  it('the shared field components the storefront forms are built from are 16px on a phone', () => {
    for (const name of ['input', 'select', 'textarea']) {
      const src = readFileSync(
        join(ROOT, 'packages', 'ui', 'src', 'components', `${name}.tsx`),
        'utf8'
      );
      const tag = openingTag(src, src.search(new RegExp(`<${name}\\b`)));
      expect(PHONE_16.test(tag), `packages/ui ${name}`).toBe(true);
    }
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
