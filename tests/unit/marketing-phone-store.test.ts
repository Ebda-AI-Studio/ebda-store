/**
 * The pure engine of the working phones (Ruling MKT-8): product parsing, options, cart, totals,
 * filters and the in-phone view stack.
 */
import { describe, expect, it } from 'vitest';
import {
  addLine,
  cartCount,
  cartTotal,
  countLabel,
  defaultSelection,
  fmtEGP,
  initialState,
  lineFor,
  optionGroups,
  productMatches,
  readProduct,
  reduce,
  removeLine,
  searchProducts,
  setQty,
  type Action,
  type Product,
  type State,
} from '../../apps/marketing/src/lib/phone-store';

const shirt = readProduct({
  pId: 'qa-1',
  pName: 'قميص كتان أبيض',
  pPrice: '1450',
  pImg: '/looks/img/qa__shirt.webp',
  pImgs: '/looks/img/qa__shirt.webp,/looks/img/qb__shirt.webp',
  pCat: 'shirts',
  pSizes: 'S|M|L',
  pColors: 'أبيض:#f4f4f2|بيج:#d8c9b0',
})!;
const bag = readProduct({
  pId: 'qa-2',
  pName: 'حقيبة',
  pPrice: '3200',
  pOld: '3600',
  pCat: 'bags',
})!;
const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);

describe('fmtEGP', () => {
  it('uses Western digits and a thousands comma, like the generator', () => {
    expect(fmtEGP(1450)).toBe('1,450 ج.م');
    expect(fmtEGP(29000)).toBe('29,000 ج.م');
    expect(fmtEGP(0)).toBe('0 ج.م');
    expect(fmtEGP(18.4)).toBe('18 ج.م');
  });
});

describe('readProduct', () => {
  it('reads the generator data attributes', () => {
    expect(shirt.id).toBe('qa-1');
    expect(shirt.price).toBe(1450);
    expect(shirt.old).toBeNull();
    expect(shirt.imgs).toHaveLength(2);
    expect(shirt.cat).toEqual(['shirts']);
    expect(bag.old).toBe(3600);
  });
  it('refuses an incomplete card', () => {
    expect(readProduct({ pId: 'x', pName: 'n' })).toBeNull();
    expect(readProduct({ pName: 'n', pPrice: '5' })).toBeNull();
    expect(readProduct({ pId: 'x', pName: 'n', pPrice: 'abc' })).toBeNull();
  });
  it('camelCase dataset keys map to hyphenated detail names', () => {
    const p = readProduct({ pId: 'a', pName: 'n', pPrice: '1', pSizeMm: '14 مم' })!;
    expect(p.a['size-mm']).toBe('14 مم');
  });
});

describe('options', () => {
  it('sizes and colours become groups; a plain product has none', () => {
    const g = optionGroups(shirt);
    expect(g.map(x => x.key)).toEqual(['size', 'color']);
    expect(optionGroups(bag)).toEqual([]);
  });
  it('defaults to the first value; the pickup day follows the home selection', () => {
    expect(defaultSelection(shirt)).toEqual({ size: 'S', color: 'أبيض' });
    const meal = readProduct({ pId: 'm', pName: 'm', pPrice: '9', pDays: 'غدًا|الجمعة|السبت' })!;
    expect(defaultSelection(meal).day).toBe('غدًا');
    expect(defaultSelection(meal, 2).day).toBe('السبت');
  });
});

describe('cart', () => {
  const a = lineFor(shirt, { size: 'M', color: 'أبيض' });
  it('the same product with another size is another line; the same options merge', () => {
    let c = addLine([], a);
    c = addLine(c, lineFor(shirt, { size: 'M', color: 'أبيض' }));
    c = addLine(c, lineFor(shirt, { size: 'L', color: 'أبيض' }));
    expect(c).toHaveLength(2);
    expect(c[0].qty).toBe(2);
    expect(cartCount(c)).toBe(3);
    expect(cartTotal(c)).toBe(3 * 1450);
  });
  it('setQty changes, 0 removes, unknown key is a no-op; quantity is capped', () => {
    const c = addLine([], a);
    expect(setQty(c, a.key, 4)[0].qty).toBe(4);
    expect(setQty(c, a.key, 0)).toEqual([]);
    expect(setQty(c, 'nope', 9)).toEqual(c);
    expect(setQty(c, a.key, 999)[0].qty).toBe(20);
    expect(removeLine(c, a.key)).toEqual([]);
  });
  it('is immutable', () => {
    const c = addLine([], a);
    addLine(c, a);
    setQty(c, a.key, 5);
    expect(c[0].qty).toBe(1);
  });
  it('totals sum price x qty across lines', () => {
    let c = addLine([], lineFor(shirt, {}, 2));
    c = addLine(c, lineFor(bag, {}, 1));
    expect(cartTotal(c)).toBe(2 * 1450 + 3200);
  });
  it('count label in Egyptian Arabic', () => {
    expect([0, 1, 2, 3, 11].map(countLabel)).toEqual([
      'السلة فاضية',
      'منتج واحد في السلة',
      'منتجين في السلة',
      '3 منتجات في السلة',
      '11 منتج في السلة',
    ]);
  });
});

describe('filters', () => {
  const tent = readProduct({
    pId: 't',
    pName: 't',
    pPrice: '1650',
    pOcc: 'birthday grad',
    pCat: 'rings',
  })!;
  it('matches category tokens; "all" and empty match everything', () => {
    expect(productMatches(shirt, { cat: 'shirts' })).toBe(true);
    expect(productMatches(shirt, { cat: 'bags' })).toBe(false);
    expect(productMatches(shirt, { cat: 'all' })).toBe(true);
    expect(productMatches(shirt, {})).toBe(true);
  });
  it('facets combine (AND): occasion + budget ceiling', () => {
    expect(productMatches(tent, { occ: 'grad', max: '2000' })).toBe(true);
    expect(productMatches(tent, { occ: 'grad', max: '1000' })).toBe(false);
    expect(productMatches(tent, { occ: 'engagement', max: '2000' })).toBe(false);
  });
  it('a category with nothing leaves no visible product (the empty state)', () => {
    const all: Product[] = [shirt, bag];
    expect(all.filter(p => productMatches(p, { cat: 'pickles' }))).toHaveLength(0);
  });
  it('searches names, ignoring diacritics and case', () => {
    expect(searchProducts([shirt, bag], 'قميص').map(p => p.id)).toEqual(['qa-1']);
    expect(searchProducts([shirt, bag], '  ')).toEqual([]);
    expect(searchProducts([shirt, bag], 'حَقيبة').map(p => p.id)).toEqual(['qa-2']);
  });
});

describe('view stack', () => {
  it('home -> product -> back', () => {
    let s = run(initialState(), { type: 'open', view: { t: 'pdp', id: 'qa-1' } });
    expect(s.stack).toEqual([{ t: 'pdp', id: 'qa-1' }]);
    s = run(s, { type: 'back' });
    expect(s.stack).toEqual([]);
    expect(run(s, { type: 'back' })).toBe(s);
  });
  it('opening the view already on top is a no-op; a sheet replaces a sheet', () => {
    const s = run(initialState(), { type: 'open', view: { t: 'cart' } });
    expect(run(s, { type: 'open', view: { t: 'cart' } })).toBe(s);
    expect(run(s, { type: 'open', view: { t: 'menu' } }).stack).toEqual([{ t: 'menu' }]);
  });
  it('the cart sheet opens over a product page and checkout swaps it for the demo screen', () => {
    let s = run(
      initialState(),
      { type: 'open', view: { t: 'pdp', id: 'qa-1' } },
      { type: 'add', line: lineFor(shirt, {}) }
    );
    s = run(s, { type: 'open', view: { t: 'cart' } });
    expect(s.stack.map(v => v.t)).toEqual(['pdp', 'cart']);
    s = run(s, { type: 'checkout' });
    expect(s.stack.map(v => v.t)).toEqual(['pdp', 'done']);
    s = run(s, { type: 'back' }, { type: 'back' });
    expect(s.stack).toEqual([]);
    expect(cartCount(s.cart)).toBe(1); // the demo order places nothing and keeps the cart
  });
  it('checkout with an empty cart does nothing', () => {
    const s = run(initialState(), { type: 'open', view: { t: 'cart' } });
    expect(run(s, { type: 'checkout' })).toBe(s);
  });
  it('closeAll clears the stack; filters set and clear', () => {
    let s = run(
      initialState(),
      { type: 'open', view: { t: 'pdp', id: 'a' } },
      { type: 'open', view: { t: 'cart' } },
      { type: 'closeAll' }
    );
    expect(s.stack).toEqual([]);
    s = run(s, { type: 'filter', facet: 'cat', value: 'bags' });
    expect(s.filters).toEqual({ cat: 'bags' });
    s = run(s, { type: 'clearFilters' });
    expect(s.filters).toEqual({});
  });
});
