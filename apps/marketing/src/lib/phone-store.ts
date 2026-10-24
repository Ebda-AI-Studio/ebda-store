/**
 * The pure half of the working phones (Ruling MKT-8): products read from data attributes, the
 * per-phone cart, category filters and the in-phone view stack. No DOM, no network, no
 * dependencies; phone-store-dom.ts binds this to a phone's markup.
 *
 * Product data comes from the snapshot (scripts/looks/snapshot.mjs, from the live demo store), as `data-p-*` on the card:
 *   id, name, price, old, img, imgs (comma list, 2-4 photos), cat / occ (space separated tokens),
 *   and per-vertical details: sizes, colors ("name:#hex|name:#hex"), shades, specs, ing, skin,
 *   portion, lead, karat, mm, mat, unit, days, engrave (max chars), gift, desc.
 */

export type Product = {
  id: string;
  name: string;
  price: number;
  old: number | null;
  img: string;
  imgs: string[];
  cat: string[];
  occ: string[];
  /** Every other data-p-* attribute, raw. */
  a: Record<string, string>;
};

const ARABIC_DIGITS = /[٠-٩]/g;
/** Western digits with a thousands comma, like the site and the generator: 1450 -> "1,450 ج.م". */
export function fmtEGP(n: number): string {
  const v = Math.round(n);
  return `${v.toLocaleString('en-US')} ج.م`.replace(ARABIC_DIGITS, d =>
    String(d.charCodeAt(0) - 1632)
  );
}

const tokens = (v: string | undefined) => (v ? v.split(/\s+/).filter(Boolean) : []);
const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** A product from a card's dataset; null when the card is not a complete product. */
export function readProduct(ds: Record<string, string | undefined>): Product | null {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(ds)) {
    if (k.startsWith('p') && k.length > 1 && k[1] === k[1].toUpperCase() && v !== undefined)
      a[k[1].toLowerCase() + k.slice(2).replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = v;
  }
  const price = num(a.price);
  if (!a.id || !a.name || Number.isNaN(price)) return null;
  const old = num(a.old);
  const imgs = a.imgs ? a.imgs.split(',').filter(Boolean) : a.img ? [a.img] : [];
  return {
    id: a.id,
    name: a.name,
    price,
    old: Number.isNaN(old) ? null : old,
    img: a.img ?? imgs[0] ?? '',
    imgs,
    cat: tokens(a.cat),
    occ: tokens(a.occ),
    a,
  };
}

// ---------- options (what the shopper chooses on the product page) ----------

export type OptionValue = { v: string; hex?: string };
export type OptionGroup =
  | { key: string; label: string; kind: 'chips'; values: OptionValue[] }
  | { key: string; label: string; kind: 'swatches'; values: OptionValue[] }
  | { key: string; label: string; kind: 'text'; max: number }
  | { key: string; label: string; kind: 'check'; text: string };

const split = (v: string | undefined) => (v ? v.split('|').filter(Boolean) : []);
const named = (raw: string): OptionValue => {
  const i = raw.lastIndexOf(':');
  return i > 0 ? { v: raw.slice(0, i), hex: raw.slice(i + 1) } : { v: raw };
};

/** Option groups a product offers, in the order the page shows them. */
export function optionGroups(p: Product): OptionGroup[] {
  const g: OptionGroup[] = [];
  if (p.a.sizes)
    g.push({
      key: 'size',
      label: 'المقاس',
      kind: 'chips',
      values: split(p.a.sizes).map(v => ({ v })),
    });
  if (p.a.colors)
    g.push({
      key: 'color',
      label: 'اللون',
      kind: 'swatches',
      values: split(p.a.colors).map(named),
    });
  if (p.a.shades)
    g.push({
      key: 'shade',
      label: 'الدرجة',
      kind: 'swatches',
      values: split(p.a.shades).map(named),
    });
  if (p.a.days)
    g.push({
      key: 'day',
      label: 'يوم الاستلام',
      kind: 'chips',
      values: split(p.a.days).map(v => ({ v })),
    });
  if (p.a.engrave) {
    const max = num(p.a.engrave);
    g.push({
      key: 'engrave',
      label: `الحفر (اختياري، لحد ${Number.isNaN(max) ? 12 : max} حرف)`,
      kind: 'text',
      max: Number.isNaN(max) ? 12 : max,
    });
  }
  if (p.a.gift) {
    g.push({
      key: 'gift',
      label: 'التغليف',
      kind: 'check',
      text: 'تغليف هدية (من غير زيادة في السعر)',
    });
    g.push({ key: 'note', label: 'رسالة الكارت (اختياري)', kind: 'text', max: 60 });
  }
  return g;
}

/** Facts the page lists under the price, with their Arabic labels. `specs` render as chips. */
export const FACTS: readonly { key: string; label: string }[] = [
  { key: 'ing', label: 'المكونات' },
  { key: 'skin', label: 'نوع البشرة' },
  { key: 'portion', label: 'الحصة' },
  { key: 'lead', label: 'التحضير' },
  { key: 'karat', label: 'العيار' },
  { key: 'mm', label: 'المقاس' },
  { key: 'mat', label: 'الخامة' },
  { key: 'unit', label: 'الوحدة' },
];

/** What was chosen, by group key. A missing key means "not chosen / empty". */
export type Selection = Record<string, string>;

/** Default choice per group: the first value (the pickup day follows `preferredDay` when given). */
export function defaultSelection(p: Product, preferredDay?: number): Selection {
  const sel: Selection = {};
  for (const g of optionGroups(p)) {
    if (g.kind === 'chips' || g.kind === 'swatches') {
      const i = g.key === 'day' && preferredDay !== undefined ? preferredDay : 0;
      sel[g.key] = (g.values[i] ?? g.values[0]).v;
    } else if (g.kind === 'check') sel[g.key] = g.text.split(' (')[0];
  }
  return sel;
}

/** Short labels for the cart line: ["M", "أبيض", "حفر: أمل"]. */
export function describeSelection(p: Product, sel: Selection): string[] {
  const out: string[] = [];
  for (const g of optionGroups(p)) {
    const v = sel[g.key]?.trim();
    if (!v) continue;
    if (g.kind === 'text') out.push(g.key === 'engrave' ? `حفر: ${v}` : `كارت: ${v}`);
    else out.push(v);
  }
  return out;
}

// ---------- cart ----------

export type Line = {
  /** id + options: the same product with another size is another line. */
  key: string;
  id: string;
  name: string;
  price: number;
  img: string;
  qty: number;
  opts: string[];
};

export const MAX_QTY = 20;

export function lineKey(id: string, opts: string[]): string {
  return [id, ...opts].join('~');
}

export function lineFor(p: Product, sel: Selection = {}, qty = 1): Line {
  const opts = describeSelection(p, sel);
  return {
    key: lineKey(p.id, opts),
    id: p.id,
    name: p.name,
    price: p.price,
    img: p.img,
    qty: Math.min(MAX_QTY, Math.max(1, Math.floor(qty))),
    opts,
  };
}

/** Adds a line (merging into an existing one with the same key). Returns a new cart. */
export function addLine(cart: readonly Line[], line: Line): Line[] {
  const i = cart.findIndex(l => l.key === line.key);
  if (i < 0) return [...cart, { ...line }];
  return cart.map((l, j) => (j === i ? { ...l, qty: Math.min(MAX_QTY, l.qty + line.qty) } : l));
}

/** Sets a line's quantity; 0 or less removes it. Unknown key: unchanged. */
export function setQty(cart: readonly Line[], key: string, qty: number): Line[] {
  if (qty <= 0) return cart.filter(l => l.key !== key);
  return cart.map(l => (l.key === key ? { ...l, qty: Math.min(MAX_QTY, Math.floor(qty)) } : l));
}

export const removeLine = (cart: readonly Line[], key: string): Line[] =>
  cart.filter(l => l.key !== key);
export const cartCount = (cart: readonly Line[]): number => cart.reduce((n, l) => n + l.qty, 0);
export const cartTotal = (cart: readonly Line[]): number =>
  cart.reduce((n, l) => n + l.qty * l.price, 0);

/** "منتج واحد" / "منتجين" / "3 منتجات" / "12 منتج". */
export function countLabel(n: number): string {
  if (n <= 0) return 'السلة فاضية';
  if (n === 1) return 'منتج واحد في السلة';
  if (n === 2) return 'منتجين في السلة';
  return n <= 10 ? `${n} منتجات في السلة` : `${n} منتج في السلة`;
}

// ---------- filters ----------

/** facet -> chosen value. "cat" (default) and "occ" match tokens; "max" is a price ceiling. */
export type Filters = Record<string, string>;

export function productMatches(p: Product, f: Filters): boolean {
  for (const [facet, v] of Object.entries(f)) {
    if (!v || v === 'all') continue;
    if (facet === 'max') {
      if (!(p.price <= Number(v))) return false;
    } else {
      const have = facet === 'cat' ? p.cat : facet === 'occ' ? p.occ : tokens(p.a[facet]);
      if (!have.includes(v)) return false;
    }
  }
  return true;
}

export const isFiltered = (f: Filters): boolean => Object.values(f).some(v => v && v !== 'all');

/** Case/diacritic-insensitive name search for the search sheet. */
export function searchProducts(all: readonly Product[], q: string): Product[] {
  const norm = (s: string) =>
    s
      .replace(/[ً-ٟـ]/g, '')
      .toLowerCase()
      .trim();
  const n = norm(q);
  if (!n) return [];
  return all.filter(p => norm(p.name).includes(n));
}

// ---------- state: the view stack, the cart and the filters of one phone ----------

export type View =
  | { t: 'pdp'; id: string }
  | { t: 'cart' }
  | { t: 'menu' }
  | { t: 'search' }
  | { t: 'done' };

export type State = { stack: View[]; cart: Line[]; filters: Filters };
export const initialState = (): State => ({ stack: [], cart: [], filters: {} });

export type Action =
  | { type: 'open'; view: View }
  | { type: 'back' }
  | { type: 'closeAll' }
  | { type: 'add'; line: Line }
  | { type: 'qty'; key: string; qty: number }
  | { type: 'remove'; key: string }
  | { type: 'filter'; facet: string; value: string }
  | { type: 'clearFilters' }
  /** "Continue the order": the cart sheet gives way to the demo screen. */
  | { type: 'checkout' };

const sameView = (a: View, b: View) =>
  a.t === b.t && (a.t !== 'pdp' || (b.t === 'pdp' && a.id === b.id));

export function reduce(s: State, a: Action): State {
  switch (a.type) {
    case 'open': {
      const top = s.stack[s.stack.length - 1];
      if (top && sameView(top, a.view)) return s;
      // a sheet replaces another sheet (menu -> cart); pages stack
      const isSheet = (v: View) => v.t === 'cart' || v.t === 'menu' || v.t === 'search';
      const base = top && isSheet(top) && isSheet(a.view) ? s.stack.slice(0, -1) : s.stack;
      return { ...s, stack: [...base, a.view] };
    }
    case 'back':
      return s.stack.length ? { ...s, stack: s.stack.slice(0, -1) } : s;
    case 'closeAll':
      return s.stack.length ? { ...s, stack: [] } : s;
    case 'add':
      return { ...s, cart: addLine(s.cart, a.line) };
    case 'qty':
      return { ...s, cart: setQty(s.cart, a.key, a.qty) };
    case 'remove':
      return { ...s, cart: removeLine(s.cart, a.key) };
    case 'filter':
      return { ...s, filters: { ...s.filters, [a.facet]: a.value } };
    case 'clearFilters':
      return isFiltered(s.filters) ? { ...s, filters: {} } : s;
    case 'checkout':
      if (!s.cart.length) return s;
      return { ...s, stack: [...s.stack.filter(v => v.t !== 'cart'), { t: 'done' }] };
  }
}
