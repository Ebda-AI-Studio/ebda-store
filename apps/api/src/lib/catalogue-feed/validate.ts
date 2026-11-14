import { validGtin } from './gtin';

/**
 * Local validator for a generated Google-format feed (also the Meta XML): well-formedness + the Google Merchant Center
 * product data specification rules that a generator can break. Pure and dependency-free so a test, a script and CI can
 * all run it. It is NOT Google's own validator (that needs a Merchant Center account): see the plan's "Not verified".
 */
export interface FeedViolation {
  itemId: string | null;
  rule: string;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Tag-stack well-formedness: every open tag closed in order, no stray `&` or `<` in text. */
export function xmlWellFormed(xml: string): string | null {
  if (!xml.startsWith('<?xml')) return 'missing xml declaration';
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|<[^>]*>|&(?!(?:amp|lt|gt|quot|apos);)/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  let last = 0;
  const text = (a: number, b: number) => (xml.slice(a, b).includes('<') ? 'raw < in text' : null);
  while ((m = re.exec(xml))) {
    const t = text(last, m.index);
    if (t) return t;
    last = re.lastIndex;
    if (m[0].startsWith('&')) return 'unescaped ampersand';
    if (m[0].startsWith('<?')) continue;
    if (!m[2]) return `malformed tag ${m[0].slice(0, 30)}`;
    if (m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return `mismatched close </${m[2]}>`;
    } else stack.push(m[2]);
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

const ENUMS = {
  availability: ['in_stock', 'out_of_stock', 'preorder', 'backorder'],
  condition: ['new', 'refurbished', 'used'],
  gender: ['male', 'female', 'unisex'],
  age_group: ['newborn', 'infant', 'toddler', 'kids', 'adult'],
  identifier_exists: ['yes', 'no'],
} as const;
const PRICE = /^\d+(\.\d{1,2})? [A-Z]{3}$/;
const len = (s: string) => Array.from(s).length;

export function validateGoogleFeed(xml: string): FeedViolation[] {
  const out: FeedViolation[] = [];
  const wf = xmlWellFormed(xml);
  if (wf) return [{ itemId: null, rule: `not well-formed: ${wf}` }];
  if (!/<rss version="2.0" xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0">/.test(xml))
    out.push({ itemId: null, rule: 'rss 2.0 root with the g: namespace is missing' });
  const seen = new Set<string>();
  for (const [, body] of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const f: Record<string, string[]> = {};
    // top-level g: fields only; the nested <g:shipping> block is read separately
    const flat = body.replace(/<g:shipping>.*?<\/g:shipping>/gs, '');
    for (const [, k, v] of flat.matchAll(/<g:([a-z_]+)>(.*?)<\/g:\1>/gs))
      (f[k] ??= []).push(decode(v));
    const one = (k: string) => f[k]?.[0];
    const id = one('id') ?? null;
    const bad = (rule: string) => out.push({ itemId: id, rule });
    for (const req of [
      'id',
      'title',
      'description',
      'link',
      'image_link',
      'availability',
      'price',
      'brand',
      'condition',
    ])
      if (!one(req)) bad(`missing required ${req}`);
    if (id) {
      if (len(id) > 50) bad('id longer than 50 characters');
      if (seen.has(id)) bad('duplicate id');
      seen.add(id);
    }
    if (one('title') && len(one('title')!) > 150) bad('title longer than 150');
    if (one('description') && len(one('description')!) > 5000) bad('description longer than 5000');
    if (one('brand') && len(one('brand')!) > 70) bad('brand longer than 70');
    for (const k of ['link', 'image_link'])
      if (one(k) && !/^https?:\/\//.test(one(k)!)) bad(`${k} is not http(s)`);
    for (const u of f.additional_image_link ?? [])
      if (!/^https?:\/\//.test(u)) bad('additional_image_link is not http(s)');
    if ((f.additional_image_link?.length ?? 0) > 10) bad('more than 10 additional images');
    for (const [k, allowed] of Object.entries(ENUMS))
      if (one(k) && !(allowed as readonly string[]).includes(one(k)!))
        bad(`${k} "${one(k)}" not allowed`);
    for (const k of ['price', 'sale_price'])
      if (one(k) && !PRICE.test(one(k)!)) bad(`${k} format "${one(k)}"`);
    if (one('price') && /^0+(\.0+)? /.test(one('price')!)) bad('price is zero');
    if (
      one('sale_price') &&
      one('price') &&
      parseFloat(one('sale_price')!) >= parseFloat(one('price')!)
    )
      bad('sale_price is not below price');
    if (one('gtin') && !validGtin(one('gtin'))) bad('gtin fails the GS1 checksum');
    if (!one('gtin') && !one('mpn') && one('identifier_exists') !== 'no')
      bad('no gtin/mpn and identifier_exists is not "no"');
    if (one('mpn') && len(one('mpn')!) > 70) bad('mpn longer than 70');
    if (one('item_group_id') && len(one('item_group_id')!) > 50)
      bad('item_group_id longer than 50');
    if (one('google_product_category') && !/^\d+$/.test(one('google_product_category')!))
      bad('google_product_category must be a numeric id');
    if (one('availability') === 'preorder' && !one('availability_date'))
      bad('preorder needs availability_date');
    if (
      one('sale_price_effective_date') &&
      !/^[\dT:\-Z+]+\/[\dT:\-Z+]+$/.test(one('sale_price_effective_date')!)
    )
      bad('sale_price_effective_date format');
    if (one('color') && /\d|#/.test(one('color')!)) bad('color contains digits or #');
    const ship = body.match(/<g:shipping>(.*?)<\/g:shipping>/s)?.[1];
    if (
      ship &&
      !/<g:country>[A-Z]{2}<\/g:country>.*<g:price>\d+(\.\d{1,2})? [A-Z]{3}<\/g:price>/s.test(ship)
    )
      bad('shipping needs a country and a price');
  }
  return out;
}
