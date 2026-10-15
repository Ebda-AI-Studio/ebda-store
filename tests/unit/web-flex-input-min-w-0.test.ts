/**
 * Verification wave 3 (D2): a `flex-1` input without `min-w-0` keeps its intrinsic min width,
 * so in a row next to a button it pushed the button off-screen in WebKit at 390px (the cart
 * coupon "Apply"). Every <input>/<select>/<textarea> in the storefront that grows with
 * `flex-1` must also carry `min-w-0`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../apps/web/src');

function* tsxFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx') && !/\.test\./.test(p)) yield p;
  }
}

describe('storefront flex-1 form controls', () => {
  it('every flex-1 input also has min-w-0', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
        const end = src.indexOf('/>', m.index);
        const block = src.slice(m.index, end);
        if (/(?<![\w-])flex-1(?![\w-])/.test(block) && !block.includes('min-w-0')) {
          offenders.push(
            `${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
