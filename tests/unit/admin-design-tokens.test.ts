/**
 * Admin design-token guard (ruling docs/rulings/ADM-DS-1.md; tokens in apps/admin/src/components/ui/tokens.ts).
 *
 * Fails when apps/admin/src uses a value outside the tokens:
 *   G1  a raw Tailwind palette colour (text-red-500, bg-emerald-50, ...): use the semantic roles
 *       (primary, success, warning, info, destructive, muted + their `-ink` text pair).
 *   G2  a one-off type size `text-[13px]`: use the type scale (text-xs / sm / base / lg / xl / 2xl / 3xl).
 *   G3  a hex colour literal: colours come from the CSS variables in styles/globals.css.
 *   G4  the bare `rounded` class (4px): control = rounded-md, surface = rounded-lg, pill = rounded-full.
 *   G5  letter-spacing (`tracking-*` other than tracking-normal): it breaks Arabic letter joining.
 *   G7  a raw <input>/<select>/<textarea> (not checkbox/radio/hidden/file/range/color) that does not use FIELD_CLASSES /
 *       TEXTAREA_CLASSES (or an explicit h-10/h-11): fields sit on the 44/40 control scale.
 *   G6  a `data-ui="nav"` item that does not take its classes from navItemClasses() / bottomNavClasses().
 *
 * G1-G5 are a RATCHET: tests/unit/admin-design-tokens.baseline.json holds the per-file count of pages not yet
 * migrated (waves W2/W3 of the 2026-11-11 audit). A file may not exceed its count, a new file may not appear,
 * and a file below its count fails until the baseline is tightened (UPDATE_BASELINE=1 npx vitest run
 * tests/unit/admin-design-tokens.test.ts). The baseline reaching {} is the exit gate. G6 has no baseline.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  GUARD_RULES,
  countRule,
  navIssues,
  openingTag,
  stripComments,
  type GuardRule,
} from '@ebda/shared/design';

const SRC = join(__dirname, '../../apps/admin/src');
const BASELINE = join(__dirname, 'admin-design-tokens.baseline.json');
const TOKENS = 'components/ui/tokens.ts';

const RULES = GUARD_RULES;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__tests__' ? [] : walk(p);
    return /\.tsx?$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

const FIELD_SKIP = /\btype=["'](?:checkbox|radio|hidden|file|range|color)["']/;
/** G7: raw field tags that are off the control scale. */
export function countFields(src: string): number {
  const code = stripComments(src);
  const re = /<(?:input|select|textarea)(?=[\s>/])/g;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const tag = openingTag(code, m.index);
    if (
      FIELD_SKIP.test(tag) ||
      /\b(?:FIELD_CLASSES|TEXTAREA_CLASSES)\b/.test(tag) ||
      /(?<![\w-])h-1[01](?![\w-])/.test(tag)
    )
      continue;
    n++;
  }
  return n;
}

type Counts = Record<string, Record<string, number>>; // rule -> file -> n

function scan(): { counts: Counts; nav: string[] } {
  const counts: Counts = { G1: {}, G2: {}, G3: {}, G4: {}, G5: {}, G7: {} };
  const nav: string[] = [];
  for (const p of walk(SRC)) {
    const file = relative(SRC, p);
    if (file === TOKENS) continue;
    const src = readFileSync(p, 'utf8');
    for (const r of Object.keys(RULES)) {
      const n = countRule(r as GuardRule, src);
      if (n) counts[r][file] = n;
    }
    if (p.endsWith('.tsx')) {
      const f = countFields(src);
      if (f) counts.G7![file] = f;
    }
    if (p.endsWith('.tsx'))
      nav.push(...navIssues(file, src, ['navItemClasses', 'bottomNavClasses']));
  }
  return { counts, nav };
}

describe('admin design tokens', () => {
  it('rule self-tests', () => {
    expect(countRule('G1', '<p className="text-red-500 bg-emerald-50/10">')).toBe(2);
    expect(countRule('G1', '<p className="text-destructive-ink bg-primary/10">')).toBe(0);
    expect(countRule('G1', 'className="hover:text-gray-900 dark:bg-blue-900/30"')).toBe(2);
    expect(countRule('G2', 'className="text-[13px] sm:text-sm"')).toBe(1);
    expect(countRule('G2', 'className="text-xs"')).toBe(0);
    expect(countRule('G3', "style={{ color: '#a6b0ac' }}")).toBe(1);
    expect(countRule('G3', "href='#abc'")).toBe(0);
    expect(countRule('G4', 'className="rounded border"')).toBe(1);
    expect(countRule('G4', 'className="rounded-md rounded-full"')).toBe(0);
    expect(countRule('G4', 'className="sm:rounded"')).toBe(1);
    expect(countRule('G5', 'className="tracking-tight font-bold"')).toBe(1);
    expect(countRule('G5', 'className="tracking-normal"')).toBe(0);
    expect(countRule('G1', '// text-red-500 in a comment\nconst a = 1;')).toBe(0);
    expect(countRule('G1', '/* bg-blue-500 */ const a = 1;')).toBe(0);
  });

  it('negative control: a hand-styled nav item is caught (G6)', () => {
    const bad = '<Link data-ui="nav" className="rounded px-3 bg-primary" href="/x">x</Link>';
    const good =
      '<Link data-ui="nav" className={navItemClasses({ kind: \'tab\', active })} href="/x">x</Link>';
    expect(navIssues('a.tsx', bad, ['navItemClasses'])).toEqual(['a.tsx:1']);
    expect(navIssues('a.tsx', good, ['navItemClasses'])).toEqual([]);
  });

  it('G7 self-test and negative control', () => {
    expect(countFields('<input type="text" className="px-3 py-2 border" />')).toBe(1);
    expect(countFields('<input type="text" className={FIELD_CLASSES} />')).toBe(0);
    expect(countFields('<input type="checkbox" className="h-4 w-4" />')).toBe(0);
    expect(countFields('<select className={`${FIELD_CLASSES} w-40`}>')).toBe(0);
    expect(countFields('<textarea className="rounded border" />')).toBe(1);
    expect(countFields('<Input label="x" />')).toBe(0);
  });

  it('no count exceeds the BASE branch baseline (the ratchet only shrinks)', () => {
    const ref = process.env.BASE_REF ?? 'origin/main';
    let baseTxt: string;
    try {
      baseTxt = execFileSync(
        'git',
        ['show', `${ref}:tests/unit/admin-design-tokens.baseline.json`],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
    } catch {
      return; // no base ref in this checkout (shallow clone): CI fetches it; the local ratchet below still holds
    }
    const base: Counts = JSON.parse(baseTxt);
    const now: Counts = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const loosened: string[] = [];
    for (const rule of Object.keys(now)) {
      if (!base[rule]) continue; // a rule introduced by this PR has no base to compare with
      for (const [f, n] of Object.entries(now[rule]!))
        if (n > (base[rule]![f] ?? 0))
          loosened.push(`${rule} ${f}: ${n} > base ${base[rule]![f] ?? 0}`);
    }
    expect(loosened, `baseline loosened against ${ref}`).toEqual([]);
  });

  it('nav items take their classes from the tokens (G6)', () => {
    expect(scan().nav).toEqual([]);
  });

  it('G1-G5 never grow past the baseline and the baseline never goes stale', () => {
    const { counts } = scan();
    if (process.env.UPDATE_BASELINE === '1' || !existsSync(BASELINE)) {
      const sorted = Object.fromEntries(
        Object.entries(counts).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).sort())])
      );
      writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
    }
    const base: Counts = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const grew: string[] = [];
    const stale: string[] = [];
    for (const rule of [...Object.keys(RULES), 'G7']) {
      const files = new Set([...Object.keys(counts[rule]), ...Object.keys(base[rule] ?? {})]);
      for (const f of files) {
        const now = counts[rule][f] ?? 0;
        const was = base[rule]?.[f] ?? 0;
        if (now > was) grew.push(`${rule} ${f}: ${now} > baseline ${was}`);
        if (now < was) stale.push(`${rule} ${f}: ${now} < baseline ${was}`);
      }
    }
    expect(grew, 'outside the design tokens (see components/ui/tokens.ts)').toEqual([]);
    expect(stale, 'baseline is stale: UPDATE_BASELINE=1 vitest run this file').toEqual([]);
  });
});
