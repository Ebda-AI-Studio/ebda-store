/**
 * Marketing design-token ratchet (apps/marketing/src/app/*.css; tokens in globals.css `:root`).
 *
 *   T1  raw px in padding / margin / gap          -> use --space-*
 *   T2  raw px in any *radius                      -> use --radius-*
 *   T3  EVERY font-size that is not `var(--fs-*)`  -> use the type scale (rem, em, px, clamp(), calc() all count)
 *   T4  physical left/right margin, padding, float, text-align (breaks RTL) -> logical properties; no baseline
 *
 * T1-T3 are a RATCHET per file (tests/unit/marketing-design-tokens.baseline.json). Three things keep it honest:
 *   - the generated blocks (nav-products in globals.css, site-footer in chrome.css) are skipped by their EXACT marker
 *     names in their EXACT file, once each; any other `name:start` / `name:end` comment fails the test, so a comment
 *     cannot switch counting off;
 *   - comments are stripped before counting, so prose never counts and never hides a declaration;
 *   - the baseline is compared with the BASE branch's copy (BASE_REF, else origin/$GITHUB_BASE_REF, else origin/main):
 *     a PR that raises its own baseline fails. Unreadable base ref under CI fails; locally it is skipped.
 * A file below its baseline fails until tightened: UPDATE_BASELINE=1 npx vitest run tests/unit/marketing-design-tokens.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../../apps/marketing/src/app');
const BASELINE = join(__dirname, 'marketing-design-tokens.baseline.json');
const BASELINE_REL = 'tests/unit/marketing-design-tokens.baseline.json';

/** The only generated blocks, by exact name and the only file each may live in. */
export const GENERATED: Record<string, string> = {
  'nav-products': 'globals.css',
  'site-footer': 'chrome.css',
};

export type Counts = Record<string, Record<string, number>>; // rule -> file -> n

const stripComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

/** Marker problems in one file: unknown names, a known name in the wrong file, a name not opened+closed exactly once. */
export function markerIssues(file: string, css: string): string[] {
  const issues: string[] = [];
  const seen: Record<string, { start: number; end: number }> = {};
  for (const m of css.matchAll(/\/\*\s*([\w-]+):(start|end)\b/g)) {
    const [, name, kind] = m;
    if (GENERATED[name] !== file) {
      issues.push(`${file}: marker "${name}:${kind}" is not an allowed generated block`);
      continue;
    }
    (seen[name] ??= { start: 0, end: 0 })[kind as 'start' | 'end']++;
  }
  for (const [name, f] of Object.entries(GENERATED)) {
    if (f !== file) continue;
    const s = seen[name];
    if (!s || s.start !== 1 || s.end !== 1)
      issues.push(`${file}: generated block "${name}" must have exactly one start and one end`);
  }
  return issues;
}

/** The CSS with the real generated blocks blanked out (line breaks kept). */
function withoutGenerated(css: string): string {
  let out = css;
  for (const name of Object.keys(GENERATED)) {
    const re = new RegExp(`/\\*\\s*${name}:start\\b[\\s\\S]*?/\\*\\s*${name}:end\\b[^*]*\\*/`);
    out = out.replace(re, m => m.replace(/[^\n]/g, ' '));
  }
  return out;
}

export function declarations(
  file: string,
  css: string
): { prop: string; val: string; line: number }[] {
  const body = stripComments(withoutGenerated(css));
  const out: { prop: string; val: string; line: number }[] = [];
  let rootDepth = -1;
  let depth = 0;
  let line = 1;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\n') line++;
    if (ch === '{') {
      const head = body
        .slice(Math.max(-1, body.lastIndexOf('}', i), body.lastIndexOf(';', i)) + 1, i)
        .trim();
      depth++;
      if (rootDepth < 0 && /^:root\b/.test(head)) rootDepth = depth;
    } else if (ch === '}') {
      if (depth === rootDepth) rootDepth = -1;
      depth--;
    } else if (/[a-z-]/.test(ch) && (i === 0 || /[\s;{}]/.test(body[i - 1]))) {
      const m = /^([a-z-]+)\s*:\s*([^;{}]+?)\s*(?:;|(?=\}))/.exec(body.slice(i));
      if (m && !m[1].startsWith('--') && rootDepth < 0) {
        out.push({ prop: m[1], val: m[2], line });
        i += m[0].length - 1;
      } else if (m && m[1].startsWith('--')) {
        i += m[0].length - 1;
      }
    }
    i++;
  }
  void file;
  return out;
}

export function countCss(
  file: string,
  css: string
): { T1: number; T2: number; T3: number; physical: string[] } {
  let T1 = 0;
  let T2 = 0;
  let T3 = 0;
  const physical: string[] = [];
  for (const { prop, val, line } of declarations(file, css)) {
    const px = (val.match(/(?<![\w.-])\d+(?:\.\d+)?px(?!\w)/g) ?? []).length;
    if (/^(?:padding|margin)(?:-|$)|^(?:row-|column-)?gap$/.test(prop)) T1 += px;
    else if (/radius$/.test(prop)) T2 += px;
    else if (prop === 'font-size' && !/^var\(--fs-[a-z]+\)$/.test(val)) T3++;
    if (
      /^(?:margin|padding)-(?:left|right)$|^float$/.test(prop) ||
      (prop === 'text-align' && /^(?:left|right)$/.test(val))
    )
      physical.push(`${file}:${line} ${prop}`);
  }
  return { T1, T2, T3, physical };
}

function scan(): { counts: Counts; markers: string[]; physical: string[] } {
  const counts: Counts = { T1: {}, T2: {}, T3: {} };
  const markers: string[] = [];
  const physical: string[] = [];
  for (const file of readdirSync(DIR).filter(n => n.endsWith('.css'))) {
    const css = readFileSync(join(DIR, file), 'utf8');
    markers.push(...markerIssues(file, css));
    const c = countCss(file, css);
    for (const r of ['T1', 'T2', 'T3'] as const) if (c[r]) counts[r][file] = c[r];
    physical.push(...c.physical);
  }
  return { counts, markers, physical };
}

/** Per rule and file, every place `now` is higher than `base` (a missing entry is 0). */
export function grew(now: Counts, base: Counts): string[] {
  const out: string[] = [];
  for (const rule of Object.keys(now)) {
    for (const [f, n] of Object.entries(now[rule])) {
      const was = base[rule]?.[f] ?? 0;
      if (n > was) out.push(`${rule} ${f}: ${n} > ${was}`);
    }
  }
  return out;
}

/** Base ref: BASE_REF, else origin/$GITHUB_BASE_REF, else origin/main. */
export function baseRef(env: NodeJS.ProcessEnv): string {
  return env.BASE_REF || (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'origin/main');
}

type BaseResult = { kind: 'ok'; counts: Counts } | { kind: 'no-ref' } | { kind: 'no-file' };
function readBase(ref: string): BaseResult {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: 'ignore',
    });
  } catch {
    return { kind: 'no-ref' };
  }
  try {
    const txt = execFileSync('git', ['show', `${ref}:${BASELINE_REL}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { kind: 'ok', counts: JSON.parse(txt) };
  } catch {
    return { kind: 'no-file' }; // the base predates this guard: the baseline is being introduced
  }
}

describe('marketing design tokens', () => {
  it('self-test: every bypass fails', () => {
    // (a) a comment cannot switch counting off
    const sneaky =
      '/* foo:start (generated) */\n.a { padding: 7px; font-size: 13px; }\n/* foo:end */';
    expect(markerIssues('globals.css', sneaky)).toHaveLength(3); // two unknown markers + the real nav-products block missing
    expect(markerIssues('globals.css', sneaky).filter(i => i.includes('"foo:'))).toHaveLength(2);
    // ...and a real block name in the wrong file, or a duplicated one, fails too
    expect(
      markerIssues('about.css', '/* nav-products:start x */\n/* nav-products:end */')
    ).not.toEqual([]);
    const real = '/* nav-products:start (generated from X) */ a{} /* nav-products:end */';
    expect(markerIssues('globals.css', real).some(i => i.includes('nav-products'))).toBe(false);
    expect(markerIssues('globals.css', real + real).some(i => i.includes('nav-products'))).toBe(
      true
    );
    // counting is NOT off after a fake marker: the declarations inside still count
    expect(countCss('a.css', sneaky)).toMatchObject({ T1: 1, T3: 1 });
    // (b) every font-size that is not an --fs token counts
    const fs = (v: string) => countCss('a.css', `.a { font-size: ${v}; }`).T3;
    for (const v of [
      '13px',
      '0.8rem',
      '1.3em',
      'clamp(1rem, 2vw, 2rem)',
      'calc(1rem + 2px)',
      'larger',
      '120%',
    ])
      expect(fs(v)).toBe(1);
    expect(fs('var(--fs-sm)')).toBe(0);
    // prose and tokens never count; declarations after a comment still do
    expect(
      countCss('a.css', '/* padding: 9px; font-size: 3px */ .a { padding: var(--space-2); }')
    ).toMatchObject({ T1: 0, T3: 0 });
    expect(
      countCss('a.css', ':root { --space-1: 4px; padding: 5px; }\n.b { margin: 3px 5px; }').T1
    ).toBe(2);
    expect(
      countCss('a.css', '.a { margin-left: 4px; text-align: right; float: left }').physical
    ).toHaveLength(3);
    // (c) 13 added raw values fail against the base
    const base: Counts = { T1: { 'globals.css': 100 }, T2: {}, T3: { 'globals.css': 20 } };
    const css = Array.from({ length: 13 }, (_, i) => `.x${i} { padding: ${i + 3}px; }`).join('\n');
    const added = countCss('globals.css', css).T1;
    expect(added).toBe(13);
    expect(
      grew({ T1: { 'globals.css': 100 + added }, T2: {}, T3: { 'globals.css': 20 } }, base)
    ).toEqual(['T1 globals.css: 113 > 100']);
    expect(grew({ T1: { 'new.css': 1 }, T2: {}, T3: {} }, base)).toEqual(['T1 new.css: 1 > 0']); // a new file cannot start dirty
    expect(grew({ T1: { 'globals.css': 99 }, T2: {}, T3: {} }, base)).toEqual([]);
    // base ref resolution
    expect(baseRef({ BASE_REF: 'origin/x' })).toBe('origin/x');
    expect(baseRef({ GITHUB_BASE_REF: 'fix/y' })).toBe('origin/fix/y');
    expect(baseRef({})).toBe('origin/main');
  });

  it('only the two real generated blocks are skipped; no stray markers', () => {
    expect(scan().markers).toEqual([]);
  });

  it('no logical-property regressions (physical left/right break RTL)', () => {
    expect(scan().physical).toEqual([]);
  });

  it('this PR does not raise the baseline over the BASE branch', () => {
    const ref = baseRef(process.env);
    const base = readBase(ref);
    if (base.kind === 'no-ref') {
      if (process.env.CI)
        throw new Error(
          `base ref ${ref} is not fetched: the ratchet cannot compare (fetch it, fetch-depth: 0)`
        );
      return; // local checkout without the base ref
    }
    if (base.kind === 'no-file') return;
    const now: Counts = JSON.parse(readFileSync(BASELINE, 'utf8'));
    expect(grew(now, base.counts), `baseline loosened against ${ref}`).toEqual([]);
  });

  it('T1-T3 never grow past the baseline and the baseline never goes stale', () => {
    const { counts } = scan();
    if (process.env.UPDATE_BASELINE === '1' || !existsSync(BASELINE)) {
      const sorted = Object.fromEntries(
        Object.entries(counts).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).sort())])
      );
      writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
    }
    const base: Counts = JSON.parse(readFileSync(BASELINE, 'utf8'));
    expect(
      grew(counts, base),
      'raw values added: use the --space-* / --radius-* / --fs-* tokens'
    ).toEqual([]);
    expect(grew(base, counts), 'baseline is stale: run UPDATE_BASELINE=1 to tighten it').toEqual(
      []
    );
  });
});
