/**
 * WCAG 4.1.2 guard (admin audit P1-4): every switch in apps/admin/src has an accessible name.
 *   - `<Toggle>` / `<ToggleSwitch>` must pass `label=` (or `aria-label` / `aria-labelledby`).
 *   - any other `role="switch"` element needs `aria-label` / `aria-labelledby`, or must sit inside a `<label>` that names it.
 * No baseline: the audit found 45 nameless switches on 8 pages, all fixed; this keeps it at zero.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { openingTag, stripComments } from '@ebda/shared/design';

const SRC = join(__dirname, '../../apps/admin/src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p);
    return n.endsWith('.tsx') && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

/** `file:line` of every unnamed switch in `src`. */
export function unnamedSwitches(file: string, raw: string): string[] {
  const src = stripComments(raw);
  const out: string[] = [];
  const at = (i: number) => `${file}:${src.slice(0, i).split('\n').length}`;
  const open = /<(?:Toggle|ToggleSwitch)(?=[\s>/])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)))
    if (!/\b(?:label|aria-label|aria-labelledby)=/.test(openingTag(src, m.index)))
      out.push(at(m.index));
  const re = /<[A-Za-z.]+(?=[\s>])/g;
  while ((m = re.exec(src))) {
    const tag = openingTag(src, m.index);
    if (!/\brole=["']switch["']/.test(tag) || /aria-label(?:ledby)?=/.test(tag)) continue;
    const before = src.slice(0, m.index);
    const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
    if (!wrapped) out.push(at(m.index));
  }
  return out;
}

describe('admin switches have accessible names', () => {
  it('self-test: catches a nameless switch, accepts named and label-wrapped ones', () => {
    expect(unnamedSwitches('a.tsx', '<Toggle checked={a} onChange={b} />')).toEqual(['a.tsx:1']);
    expect(unnamedSwitches('a.tsx', '<Toggle checked={a} onChange={b} label="x" />')).toEqual([]);
    expect(
      unnamedSwitches('a.tsx', '<Toggle checked={a} onChange={b} aria-labelledby="x" />')
    ).toEqual([]);
    expect(unnamedSwitches('a.tsx', '<button role="switch" aria-checked={a}>')).toEqual([
      'a.tsx:1',
    ]);
    expect(unnamedSwitches('a.tsx', '<button role="switch" aria-label="x">')).toEqual([]);
    expect(
      unnamedSwitches(
        'a.tsx',
        '<label><span>x</span><input type="checkbox" role="switch"/></label>'
      )
    ).toEqual([]);
    expect(unnamedSwitches('a.tsx', '<label>x</label><input role="switch"/>')).toEqual(['a.tsx:1']);
  });
  it('no switch in apps/admin/src is nameless', () => {
    const bad = walk(SRC).flatMap(p => unnamedSwitches(relative(SRC, p), readFileSync(p, 'utf8')));
    expect(bad).toEqual([]);
  });
});
