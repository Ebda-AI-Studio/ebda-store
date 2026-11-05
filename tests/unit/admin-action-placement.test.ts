/**
 * Action-placement standard guard (UX:U-1; docs/admin/ACTION-PLACEMENT-STANDARD.md).
 *
 * Ratchet: the pages that still break a rule are listed in admin-action-placement-known-debt.json and may only
 * SHRINK (an entry whose file is clean fails, so the list cannot rot). New code starts at zero.
 *   R3  no `backToSettings` / `backToStore` strings in a header (navigation back is the hub strip / breadcrumb).
 *   R7  no native window.confirm / window.alert (use useConfirm()).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/admin/src');
const DEBT_PATH = join(__dirname, 'admin-action-placement-known-debt.json');
const debt: { backTo: string[]; nativeDialog: string[] } = existsSync(DEBT_PATH)
  ? JSON.parse(readFileSync(DEBT_PATH, 'utf8'))
  : { backTo: [], nativeDialog: [] };

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
