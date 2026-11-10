/**
 * VT-c (independent audit): one quantity stepper drew its minus as an ASCII hyphen "-"
 * while the others used "−" (U+2212). Every decrease control renders U+2212 or an icon.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '../../apps/web/src');
function walk(d: string): string[] {
  return readdirSync(d).flatMap(f => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

/**
 * Every <button> whose aria-label expression matches `label` (AST, not a text window: the
 * button body is the JSX element's own children, so a neighbouring button can never be caught).
 */
function buttons(label: RegExp): Array<{ file: string; el: ts.JsxElement }> {
  const out: Array<{ file: string; el: ts.JsxElement }> = [];
  for (const f of walk(SRC)) {
    const sf = ts.createSourceFile(
      f,
      readFileSync(f, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const go = (n: ts.Node) => {
      if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'button') {
        const a = n.openingElement.attributes.properties.find(
          p => ts.isJsxAttribute(p) && p.name.getText() === 'aria-label'
        ) as ts.JsxAttribute | undefined;
        if (a?.initializer && label.test(a.initializer.getText()))
          out.push({ file: relative(SRC, f), el: n });
      }
      ts.forEachChild(n, go);
    };
    go(sf);
  }
  return out;
}

/** The text a button draws: its JSX text and string-literal children outside nested elements' tags. */
function visibleText(el: ts.JsxElement): string {
  const parts: string[] = [];
  const go = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.text);
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (ts.isJsxExpression(n.parent)) parts.push(` ${n.text} `);
    }
    ts.forEachChild(n, go);
  };
  el.children.forEach(go);
  return parts.join(' ');
}

const drawsIcon = (el: ts.JsxElement): boolean => {
  let found = false;
  const go = (n: ts.Node) => {
    const tag = ts.isJsxElement(n)
      ? n.openingElement.tagName
      : ts.isJsxSelfClosingElement(n)
        ? n.tagName
        : null;
    if (tag && /^(svg|[A-Z]\w*Icon)$/.test(tag.getText())) found = true;
    ts.forEachChild(n, go);
  };
  el.children.forEach(go);
  return found;
};

describe('decrease controls use the minus sign', () => {
  it('no ASCII hyphen as the visible glyph of a decrease button', () => {
    const list = buttons(/./).filter(b =>
      /t\('Decrease|cartLineLabel\('decrease/.test(b.el.openingElement.getText())
    );
    const bad = list
      .filter(b => /(^|[\s>{'"])-(?=[\s<}'"]|$)/.test(visibleText(b.el)))
      .map(b => b.file);
    expect(list.length).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});

// Taste re-audit P2-11: the minus sign was the right character but Noto Sans Arabic draws it at
// hyphen weight next to a full "+". Every stepper draws both signs as icons, never text glyphs.
describe('steppers draw both signs as icons (P2-11)', () => {
  it('every Decrease/Increase button body holds an svg or an *Icon component', () => {
    const list = buttons(/./).filter(b =>
      /t\('(?:Decrease|Increase)|cartLineLabel\('(?:decrease|increase)/.test(
        b.el.openingElement.getText()
      )
    );
    const bare = list.filter(b => !drawsIcon(b.el)).map(b => b.file);
    expect(list.length).toBeGreaterThan(10);
    expect(bare).toEqual([]);
  });
});
