/**
 * Verification wave 3 (D2): a `flex-1` input without `min-w-0` keeps its intrinsic min width,
 * so in a row next to a button it pushed the button off-screen in WebKit at 390px (the cart
 * coupon "Apply"). Every <input>/<select>/<textarea> in the storefront that grows with
 * `flex-1` must also carry `min-w-0`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      // JSX AST: the element's own opening/self-closing tag, so an unclosed `<input ...>` can never swallow a neighbour.
      const go = (n: ts.Node) => {
        const tag = ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n) ? n : null;
        if (tag && /^(input|select|textarea)$/.test(tag.tagName.getText())) {
          const block = tag.getText();
          if (/(?<![\w-])flex-1(?![\w-])/.test(block) && !block.includes('min-w-0')) {
            const line = sf.getLineAndCharacterOfPosition(tag.getStart()).line + 1;
            offenders.push(`${path.relative(ROOT, file)}:${line}`);
          }
        }
        ts.forEachChild(n, go);
      };
      go(sf);
    }
    expect(offenders).toEqual([]);
  });
});
