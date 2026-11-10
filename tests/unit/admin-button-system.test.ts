/**
 * Admin button system guard (ruling docs/rulings/2026-11-10-admin-button-system.md).
 *
 * The merchant admin had 10+ button looks (16-48px tall, radius 0/9/12/14/pill, 12-16px type) because
 * every page styled its own `<button>`. Now ONE primitive owns the look:
 * apps/admin/src/components/ui/Button.tsx (`Button` + `buttonVariants()`, sizes sm/md/lg + icon-*).
 *
 * Fails when, in apps/admin/src:
 *   B1  a raw `<button>` styles itself: its className carries a height, padding, type size, radius,
 *       fill or border class (h-*, min-h-*, p-/px-/py-*, text-xs..text-xl, rounded*, bg-*, border*)
 *       and does not take its classes from buttonVariants(). Layout-only classes (flex, gap, absolute,
 *       w-full, colours of text) are fine: an unstyled wrapper is not a button look.
 *   B2  a <Button> or buttonVariants() overrides the scale (h-*, min-h-*, px-/py-/p-*, rounded*,
 *       text-xs..text-xl) through className. Pick a size instead.
 *   B3  admin imports the storefront's Button from @ebda/ui (its sizes are not the admin scale).
 *
 * Not a button look, so exempt from B1 (the reason is in the markup, greppable):
 *   - role="switch" | "menuitem" | "menuitemradio" | "menuitemcheckbox" | "option" | "radio" | "tab" (a tab
 *     strip has its own underline language) | "gridcell"
 *   - data-ui="<kind>" with kind in EXEMPT_KINDS below (swatch, tile, row, nav, canvas, handle).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/admin/src');
const PRIMITIVE = 'components/ui/Button.tsx';
/**
 * Files another open PR is rewriting, migrated right after it merges. May only SHRINK: a listed file
 * with no findings fails, so the list cannot rot.
 */
export const DEFERRED: Record<string, string> = {
  'app/login/page.tsx': 'PR #533 rewrites the sign-in pages; migrate its 2 buttons once it merges',
};

export const EXEMPT_ROLES = [
  'switch',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'radio',
  'tab',
  'gridcell',
];
/** data-ui kinds: a control whose look is its content, not a button. */
export const EXEMPT_KINDS = [
  'swatch', // a colour / font / image chip whose fill IS the value
  'tile', // a card-sized choice (template, plan, payment method) - the whole card is clickable
  'row', // a full-width list / table row that opens something
  'nav', // sidebar / hub navigation item
  'canvas', // visual-editor canvas overlay (section outline, drop zone)
  'handle', // drag handle / resize grip
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__tests__' ? [] : walk(p);
    return /\.tsx$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

/** The JSX opening tag starting at `i` (brace-balanced, so `=>` inside handlers does not end it). */
export function openingTag(src: string, i: number): string {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[j - 1] !== '=') return src.slice(i, j + 1);
  }
  return src.slice(i);
}

/** Everything the className attribute can resolve to (static string or the whole expression). */
export function classAttr(tag: string): string {
  const s = tag.match(/\bclassName="([^"]*)"/);
  if (s) return s[1];
  const at = tag.search(/\bclassName=\{/);
  if (at < 0) return '';
  let depth = 0;
  const start = tag.indexOf('{', at);
  for (let j = start; j < tag.length; j++) {
    if (tag[j] === '{') depth++;
    else if (tag[j] === '}' && --depth === 0) return tag.slice(start + 1, j);
  }
  return tag.slice(start + 1);
}

const TOKEN = (re: string) => new RegExp(`(?:^|[\\s'"\`:])(?:!)?(?:${re})(?=$|[\\s'"\`])`);
const SELF_STYLE = TOKEN(
  'h-\\S+|min-h-\\S+|p[xy]?-\\S+|text-(?:xs|sm|base|lg|xl|\\[\\d+px\\])|rounded(?:-\\S+)?|bg-\\S+|border(?:-\\S+)?'
);
const SCALE_OVERRIDE = TOKEN(
  'h-\\S+|min-h-\\S+|p[xy]?-\\S+|rounded(?:-\\S+)?|text-(?:xs|sm|base|lg|xl|\\[\\d+px\\])'
);

export function isExempt(tag: string): boolean {
  const role = tag.match(/\brole=["']([a-z]+)["']/);
  if (role && EXEMPT_ROLES.includes(role[1])) return true;
  const kind = tag.match(/\bdata-ui=["']([a-z-]+)["']/);
  return !!kind && EXEMPT_KINDS.includes(kind[1]);
}

/**
 * The class text a className expression can carry, with every bare identifier it names
 * (`className={btn}`, `cn(btnOutline, x)`) replaced by that file's `const <id> = '...'` string,
 * so a style hoisted into a variable is still seen.
 */
export function resolveClasses(cls: string, src: string): string {
  const ids = cls.match(/\b[A-Za-z_]\w*\b/g) ?? [];
  const extra = ids.flatMap(id => {
    const m = src.match(
      new RegExp(`\\bconst\\s+${id}\\s*(?::\\s*string)?\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`)
    );
    return m ? [m[2]] : [];
  });
  return [cls, ...extra].join(' ');
}

/** B1: a raw <button> that styles itself. */
export function rawSelfStyled(tag: string, src = ''): boolean {
  if (isExempt(tag)) return false;
  const cls = classAttr(tag);
  if (/\bbuttonVariants\(/.test(cls)) return false;
  return SELF_STYLE.test(resolveClasses(cls, src));
}

/** B2: className passed to <Button>/buttonVariants() that fights the scale. */
export function overridesScale(cls: string): boolean {
  return SCALE_OVERRIDE.test(cls.replace(/\b(?:sm|md|lg|xl|2xl|max-\w+|coarse):\S+/g, ''));
}

type Finding = { file: string; line: number; rule: string; snippet: string };

function scan(): Finding[] {
  const out: Finding[] = [];
  for (const p of walk(SRC)) {
    const file = relative(SRC, p);
    if (file === PRIMITIVE) continue;
    const src = readFileSync(p, 'utf8');
    const lineOf = (i: number) => src.slice(0, i).split('\n').length;
    if (/import\s*\{[^}]*\bButton\b[^}]*\}\s*from\s*['"]@ebda\/ui['"]/.test(src))
      out.push({ file, line: 1, rule: 'B3', snippet: "Button from '@ebda/ui'" });
    const re = /<(button|Button)(?=[\s>])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = openingTag(src, m.index);
      const snippet = tag.replace(/\s+/g, ' ').slice(0, 140);
      if (m[1] === 'button' && rawSelfStyled(tag, src))
        out.push({ file, line: lineOf(m.index), rule: 'B1', snippet });
      if (m[1] === 'Button' && overridesScale(resolveClasses(classAttr(tag), src)))
        out.push({ file, line: lineOf(m.index), rule: 'B2', snippet });
    }
    const bv = /buttonVariants\(\{([^}]*)\}\)/g;
    while ((m = bv.exec(src))) {
      const cls = m[1].match(/className:\s*(['"`])([^'"`]*)\1/);
      if (cls && overridesScale(cls[2]))
        out.push({ file, line: lineOf(m.index), rule: 'B2', snippet: m[0].slice(0, 140) });
    }
  }
  return out;
}

describe('admin button system', () => {
  it('rule self-tests', () => {
    const t = (s: string) => openingTag(s, 0);
    expect(rawSelfStyled(t('<button className="h-9 rounded-lg px-3">x</button>'))).toBe(true);
    expect(rawSelfStyled(t('<button className="text-xs text-primary underline">x</button>'))).toBe(
      true
    );
    expect(rawSelfStyled(t('<button className={cn("p-1", a && "bg-muted")}>'))).toBe(true);
    expect(rawSelfStyled(t('<button className="absolute inset-0 flex">x</button>'))).toBe(false);
    expect(rawSelfStyled(t('<button className={buttonVariants({ size: "sm" })}>'))).toBe(false);
    expect(rawSelfStyled(t('<button role="switch" className="h-6 w-11 rounded-full">'))).toBe(
      false
    );
    expect(rawSelfStyled(t('<button data-ui="swatch" className="h-8 w-8 rounded-full">'))).toBe(
      false
    );
    expect(rawSelfStyled(t('<button data-ui="nope" className="h-8 rounded">'))).toBe(true);
    expect(rawSelfStyled(t('<button onClick={() => go()} className="px-2">'))).toBe(true);
    const hoisted = "const btn = 'h-9 rounded-lg border px-3';";
    expect(rawSelfStyled(t('<button className={btn}>'), hoisted)).toBe(true);
    expect(rawSelfStyled(t('<button className={cn(btn, open && "x")}>'), hoisted)).toBe(true);
    expect(rawSelfStyled(t('<button className={wrap}>'), "const wrap = 'flex gap-2';")).toBe(false);
    expect(overridesScale('w-full justify-start gap-2')).toBe(false);
    expect(overridesScale('h-9 w-full')).toBe(true);
    expect(overridesScale('rounded-full')).toBe(true);
    expect(overridesScale('sm:w-auto mt-2')).toBe(false);
  });

  it('no button outside the primitive styles its own size, padding, radius or fill', () => {
    const findings = scan().filter(f => !(f.file in DEFERRED));
    const report = findings.map(f => `${f.rule} ${f.file}:${f.line}  ${f.snippet}`).join('\n');
    expect(
      findings,
      `Use <Button variant size> or buttonVariants() from components/ui/Button.tsx (or mark a non-button control with an exempt role / data-ui kind):\n${report}`
    ).toEqual([]);
  });

  it('the deferred list only names files that still have findings', () => {
    const dirty = new Set(scan().map(f => f.file));
    expect(Object.keys(DEFERRED).filter(f => !dirty.has(f))).toEqual([]);
  });

  it('the primitive keeps the agreed scale', () => {
    const src = readFileSync(join(SRC, PRIMITIVE), 'utf8');
    for (const s of ['sm: `h-8', "md: 'h-11", "lg: 'h-11", "'icon-sm': `h-8 w-8"])
      expect(src).toContain(s);
    const scale = src.slice(
      src.indexOf('const BASE'),
      src.indexOf('export function buttonVariants')
    );
    expect(scale.match(/rounded-(?:sm|md|lg|xl|full|none|\[)/g)).toEqual(['rounded-md']);
  });
});
