/**
 * Action-placement standard guard (UX:U-1; docs/admin/ACTION-PLACEMENT-STANDARD.md).
 *
 * Ratchet: the pages that still break a rule are listed in admin-action-placement-known-debt.json and may only
 * SHRINK (an entry whose file is clean fails, so the list cannot rot). New code starts at zero.
 *   R3  no `backToSettings` / `backToStore` strings in a header (navigation back is the hub strip / breadcrumb).
 *   R7  no native window.confirm / window.alert (use useConfirm()).
 *   R2  at most ONE filled (primary) button in a header `actions={...}` slot (UX:U-1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/admin/src');
const DEBT_PATH = join(__dirname, 'admin-action-placement-known-debt.json');
const debt: { backTo: string[]; nativeDialog: string[]; multiPrimary?: string[] } = existsSync(
  DEBT_PATH
)
  ? JSON.parse(readFileSync(DEBT_PATH, 'utf8'))
  : { backTo: [], nativeDialog: [] };
debt.multiPrimary ??= [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p);
    return /\.tsx?$/.test(n) && !/\.(test|spec)\./.test(n) && !p.includes('__tests__') ? [p] : [];
  });
}
const files = walk(SRC).map(p => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }));

const BACK = /\b(backToSettings|backToStore)\b/;
const NATIVE = /(^|[^.A-Za-z0-9_])(window\.)?(confirm|alert)\(/m;

/** The text of every `actions={...}` JSX attribute (brace-balanced). */
export function actionSlots(src: string): string[] {
  const out: string[] = [];
  const re = /\bactions=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const c = src[i++];
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

const QUIET = /variant=["'{]+\s*(outline|ghost|link|secondary)/;
/** Filled buttons in a slot: a <Button> with no quiet variant, or buttonVariants() with no quiet variant. */
export function filledButtons(slot: string): number {
  let n = 0;
  for (const m of slot.matchAll(/<Button\b([^>]*)>/g)) if (!QUIET.test(m[1] ?? '')) n++;
  for (const m of slot.matchAll(/buttonVariants\(\s*(\{[^)]*\})?\s*\)/g))
    if (!QUIET.test((m[1] ?? '').replace(/variant:\s*['"]/, 'variant="'))) n++;
  return n;
}

describe('action placement', () => {
  const backHits = files
    .filter(f => BACK.test(f.src))
    .map(f => f.rel)
    .sort();
  const nativeHits = files
    .filter(f => !/useConfirm|ConfirmActionModal/.test(f.rel))
    .filter(f => NATIVE.test(f.src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
    .map(f => f.rel)
    .sort();

  const multiHits = files
    .filter(f => actionSlots(f.src).some(slot => filledButtons(slot) > 1))
    .map(f => f.rel)
    .sort();

  it('filledButtons counts only filled buttons (self-test of the R2 rule)', () => {
    expect(filledButtons('<Button>a</Button><Button variant="outline">b</Button>')).toBe(1);
    expect(filledButtons('<Button>a</Button><Button variant="default">b</Button>')).toBe(2);
    expect(filledButtons('<Button variant="ghost">a</Button>')).toBe(0);
    expect(actionSlots('x actions={<A b={{c:1}} />} y')).toEqual(['<A b={{c:1}} />']);
  });
  it('no NEW header with more than one filled button', () => {
    expect(multiHits.filter(f => !debt.multiPrimary!.includes(f))).toEqual([]);
  });
  it('the multi-primary debt list only lists files that still break the rule', () => {
    expect(debt.multiPrimary!.filter(f => !multiHits.includes(f))).toEqual([]);
  });
  it('no NEW page puts back-to-settings / back-to-store in a header', () => {
    expect(backHits.filter(f => !debt.backTo.includes(f))).toEqual([]);
  });
  it('the back-to debt list only lists files that still break the rule', () => {
    expect(debt.backTo.filter(f => !backHits.includes(f))).toEqual([]);
  });
  it('no NEW native confirm()/alert() (use useConfirm)', () => {
    expect(nativeHits.filter(f => !debt.nativeDialog.includes(f))).toEqual([]);
  });
  it('the native-dialog debt list only lists files that still break the rule', () => {
    expect(debt.nativeDialog.filter(f => !nativeHits.includes(f))).toEqual([]);
  });
});
