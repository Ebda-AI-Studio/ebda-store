// Phase B5 Task 2 (finding): the Dahab branch of ProductDetailClient never passed `mediaSlot`, so a
// Dahab product with a 3D model showed no viewer. The slot now carries the same toggle + panel the
// default PDP renders, behind the same `model3d` gate (which already folds in `product_3d`), and a
// product without a model renders nothing (unfilled features render nothing).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseSource, findAll, callsTo, isStr } from './helpers/ts-ast';

const PDP = path.resolve(
  __dirname,
  '../../apps/web/src/app/products/[slug]/ProductDetailClient.tsx'
);
const src = readFileSync(PDP, 'utf8');
// AST, not a text window: the slot is the `mediaSlot` JSX attribute INSIDE the
// `if (templateId === 'dahab')` statement, so the default PDP's own markup (or a comment)
// cannot satisfy these checks.
const sf = parseSource(PDP);
const branch = findAll(
  sf,
  (n): n is ts.IfStatement =>
    ts.isIfStatement(n) && n.expression.getText() === "templateId === 'dahab'"
)[0];
const mediaSlot = branch
  ? findAll(
      branch,
      (n): n is ts.JsxAttribute => ts.isJsxAttribute(n) && n.name.getText() === 'mediaSlot'
    )[0]
  : undefined;
const slotExpr =
  mediaSlot?.initializer && ts.isJsxExpression(mediaSlot.initializer)
    ? mediaSlot.initializer.expression
    : undefined;
const jsxNamed = (root: ts.Node, tag: string) =>
  findAll(
    root,
    (n): n is ts.JsxOpeningLikeElement => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)
  ).some(e => e.tagName.getText() === tag);

describe('Dahab PDP 3D slot', () => {
  it('the dahab branch passes a mediaSlot', () => {
    expect(mediaSlot).toBeDefined();
  });
  it('it is gated on the same model3d value as the default PDP, and is undefined without a model', () => {
    expect(src).toMatch(/const model3d = product\?\.model3d && isEnabled\('product_3d'\)/);
    expect(slotExpr && ts.isConditionalExpression(slotExpr)).toBe(true);
    const cond = slotExpr as ts.ConditionalExpression;
    expect(cond.condition.getText()).toBe('model3d');
    expect(cond.whenFalse.getText()).toBe('undefined');
  });
  it('it renders the toggle and the panel, and keeps the analytics event', () => {
    expect(slotExpr).toBeDefined();
    expect(jsxNamed(slotExpr!, 'Model3dToggle')).toBe(true);
    expect(jsxNamed(slotExpr!, 'ProductModel3dPanel')).toBe(true);
    expect(
      callsTo(slotExpr!, 'captureEvent').some(
        c => isStr(c.arguments[0]) && c.arguments[0].text === 'product_3d_opened'
      )
    ).toBe(true);
  });
  it('the toggle is a 44px target (quality bar section 10)', () => {
    const toggle = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/components/ProductModel3d.tsx'),
      'utf8'
    );
    expect(toggle).toMatch(/inline-flex h-11 items-center/);
  });
  it('the slot renders under the gallery in the Dahab layout', () => {
    const pd = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/templates/dahab/ProductDetail.tsx'),
      'utf8'
    );
    expect(pd).toMatch(/<\/Gallery>|\/>\s*\{p\.mediaSlot\}/);
  });
});
