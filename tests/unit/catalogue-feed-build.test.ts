import { describe, it, expect } from 'vitest';
import { buildProductItems, buildBundleItems } from '@api/lib/catalogue-feed/build';
import {
  itemXml,
  xmlHead,
  XML_TAIL,
  itemCsvRow,
  tiktokHeaderRow,
  xmlEscape,
  csvField,
} from '@api/lib/catalogue-feed/render';
import { validateGoogleFeed, xmlWellFormed } from '@api/lib/catalogue-feed/validate';
import { validGtin } from '@api/lib/catalogue-feed/gtin';
import { googleCategoryFor } from '@api/lib/catalogue-feed/taxonomy';
import { ctx, dress, simple, store } from '../helpers/catalogue-feed-fixtures';

const feedXml = (
  items: ReturnType<typeof buildProductItems>['items'],
  platform: 'google' | 'meta' = 'google'
) =>
  xmlHead({ storeName: store.nameAr!, origin: store.origin, lang: 'ar' }) +
  items.map(i => itemXml(i, platform)).join('') +
  XML_TAIL;

describe('GTIN', () => {
  it('accepts a valid EAN-13 / UPC-A / EAN-8 and rejects bad checksums, lengths and placeholders', () => {
    expect(validGtin('4006381333931')).toBe('4006381333931');
    expect(validGtin('036000291452')).toBe('036000291452');
    expect(validGtin('96385074')).toBe('96385074');
    expect(validGtin('4006381333932')).toBeNull(); // wrong check digit
    expect(validGtin('123')).toBeNull();
    expect(validGtin('00000000')).toBeNull();
    expect(validGtin('SHELF-12')).toBeNull();
    expect(validGtin(null)).toBeNull();
  });
});

describe('simple product', () => {
  const { items, issues } = buildProductItems([simple()], ctx());
  const it0 = items[0];

  it('uses the product id, regular price as price and the shopper price as sale_price', () => {
    expect(items).toHaveLength(1);
    expect(it0.id).toBe('prod-simple');
    expect(it0.groupId).toBeUndefined();
    expect(it0.priceMinor).toBe(15000);
    expect(it0.salePriceMinor).toBe(12500);
  });
  it('is Arabic by default, falls back to English per field, strips HTML, orders images by position', () => {
    expect(it0.title).toBe('زيت زيتون & زعتر <لتر>');
    expect(it0.description).toBe('عصرة أولى.');
    const en = buildProductItems([simple()], ctx({ lang: 'en' })).items[0];
    expect(en.title).toBe('Olive Oil & Thyme <1L>');
    expect(en.description).toBe('Cold pressed.');
    expect(it0.imageLink).toBe('https://cdn.example/p0.jpg');
    expect(it0.additionalImageLinks).toEqual([
      'https://cdn.example/p1.jpg',
      'https://cdn.example/p2.jpg',
    ]);
  });
  it('sends a valid barcode as gtin and condition new', () => {
    expect(it0.gtin).toBe('4006381333931');
    expect(it0.identifierExists).toBe(true);
    expect(it0.condition).toBe('new');
  });
  it('links to the store origin, never a request header', () => {
    expect(it0.link).toBe('https://nile.ebda.app/products/olive-oil');
  });
  it('brand defaults to the store name in the feed language and is flagged', () => {
    expect(it0.brand).toBe('هدايا النيل');
    expect(issues.some(i => i.code === 'brand_is_store_name')).toBe(true);
  });
  it('an invalid barcode is dropped (identifier_exists=no) and warned, not sent as gtin', () => {
    const r = buildProductItems([simple({ barcode: 'SHELF-12' })], ctx());
    expect(r.items[0].gtin).toBeUndefined();
    expect(r.items[0].identifierExists).toBe(false);
    expect(r.issues.some(i => i.code === 'gtin_invalid')).toBe(true);
    expect(itemXml(r.items[0], 'google')).toContain(
      '<g:identifier_exists>no</g:identifier_exists>'
    );
  });
  it('brand / mpn / google category facts are honoured', () => {
    const p = simple({
      barcode: null,
      facts: [
        { key: 'Brand', value: 'Siwa', keyAr: '', valueAr: 'سيوة' },
        { key: 'MPN', value: 'SW-1', keyAr: '', valueAr: '' },
        { key: 'google_product_category', value: '422', keyAr: '', valueAr: '' },
      ],
    });
    const r = buildProductItems([p], ctx({ lang: 'en' })).items[0];
    expect(r.brand).toBe('Siwa');
    expect(r.mpn).toBe('SW-1');
    expect(r.identifierExists).toBe(true);
    expect(r.googleCategory?.id).toBe(422);
  });
});

describe('availability', () => {
  it('in stock / out of stock / untracked / backorder (gated by the store feature)', () => {
    const f = (over: object, backorderOn = false) =>
      buildProductItems([simple(over as never)], ctx({ backorderOn })).items[0].availability;
    expect(f({ inventory: 4 })).toBe('in_stock');
    expect(f({ inventory: 0 })).toBe('out_of_stock');
    expect(f({ inventory: 0, trackInventory: false })).toBe('in_stock');
    expect(f({ inventory: 0, allowBackorder: true }, false)).toBe('out_of_stock');
    expect(f({ inventory: 0, allowBackorder: true }, true)).toBe('backorder');
  });
});

describe('variants', () => {
  const { items, issues } = buildProductItems([dress()], ctx({ backorderOn: true }));

  it('one item per ACTIVE variant, id = variant id, item_group_id = product id', () => {
    expect(items.map(i => i.id)).toEqual(['var-m-red', 'var-l-red']);
    expect(items.every(i => i.groupId === 'prod-dress')).toBe(true);
    expect(issues.find(i => i.code === 'variant_inactive')?.id).toBe('var-xl-red');
  });
  it('size and colour come from the option values, in the feed language', () => {
    expect(items[0]).toMatchObject({ size: 'متوسط', color: 'أحمر' });
    expect(buildProductItems([dress()], ctx({ lang: 'en' })).items[0]).toMatchObject({
      size: 'M',
      color: 'Red',
    });
  });
  it('a variant uses its own price and compare-at; the parent stale compare-at is ignored', () => {
    expect(items[0]).toMatchObject({ priceMinor: 100000, salePriceMinor: 80000 });
    expect(items[1].priceMinor).toBe(80000); // inherits the parent price
    expect(items[1].salePriceMinor).toBeUndefined(); // no own compare-at -> no sale
  });
  it('per-variant availability and image; a variant barcode that is not a GTIN is not inherited from the parent', () => {
    expect(items[0].availability).toBe('in_stock');
    expect(items[1].availability).toBe('backorder');
    expect(items[0].imageLink).toBe('https://cdn.example/red.jpg');
    expect(items[1].imageLink).toBe('https://cdn.example/p0.jpg');
    expect(items[0].gtin).toBeUndefined();
  });
  it('titles carry the variant, breadcrumb and Google category come from the category chain', () => {
    expect(items[0].title).toBe('فستان كتان - متوسط / أحمر');
    expect(items[0].productType).toBe('ملابس > فساتين');
    expect(items[0].googleCategory?.id).toBe(1604);
  });
  it('apparel without gender/age_group is warned', () => {
    expect(issues.some(i => i.code === 'apparel_missing_attrs')).toBe(true);
  });
});

describe('exclusions', () => {
  it('no image, zero price, no title are excluded and reported', () => {
    const r = buildProductItems(
      [
        simple({ id: 'a', images: [] }),
        simple({ id: 'b', price: 0, compareAtPrice: null }),
        simple({ id: 'c', name: '', nameAr: '' }),
      ],
      ctx()
    );
    expect(r.items).toHaveLength(0);
    expect(
      r.issues
        .filter(i => i.kind === 'excluded')
        .map(i => i.code)
        .sort()
    ).toEqual(['no_image', 'no_title', 'zero_price']);
  });
  it('a relative or non-http image is not an image', () => {
    expect(
      buildProductItems([simple({ images: [{ url: '/x.jpg', position: 0 }] })], ctx()).items
    ).toHaveLength(0);
  });
});

describe('shipping and bundles', () => {
  it('a flat store-wide fee is emitted as g:shipping for Egypt', () => {
    const c = ctx({ store: { ...store, flatShippingMinor: 6000 } });
    const x = itemXml(buildProductItems([simple()], c).items[0], 'google');
    expect(x).toContain(
      '<g:shipping><g:country>EG</g:country><g:price>60.00 EGP</g:price></g:shipping>'
    );
  });
  it('a purchasable bundle becomes an item with a sale window', () => {
    const [b] = buildBundleItems(
      [
        {
          id: 'b1',
          name: 'Box',
          nameAr: 'بوكس',
          slug: 'box',
          image: 'https://cdn.example/b.jpg',
          price: 9000,
          componentSum: 12000,
          startsAt: '2026-11-01T00:00:00Z',
          expiresAt: '2026-11-30T00:00:00Z',
        },
      ],
      ctx()
    );
    expect(b).toMatchObject({ id: 'b1', isBundle: true, priceMinor: 12000, salePriceMinor: 9000 });
    expect(b.salePriceEffectiveDate).toBe('2026-11-01T00:00Z/2026-11-30T00:00Z');
    expect(
      buildBundleItems(
        [{ id: 'b2', name: 'No image', slug: 'n', price: 1, componentSum: 2 }],
        ctx()
      )
    ).toHaveLength(0);
  });
});

describe('taxonomy', () => {
  it('maps by whole word, never wildly', () => {
    expect(googleCategoryFor('Women Shoes')?.id).toBe(187);
    expect(googleCategoryFor('عطور')?.id).toBe(479);
    expect(googleCategoryFor('Misc')).toBeNull();
    expect(googleCategoryFor('Shoeshine kits')).toBeNull(); // 'shoes' is not a substring match
  });
});

describe('rendering + local Google validation', () => {
  const items = buildProductItems([simple(), dress()], ctx({ backorderOn: true })).items;

  it('escapes & < > in Arabic and English titles and the file is well-formed', () => {
    const xml = feedXml(items);
    expect(xml).toContain('<g:title>زيت زيتون &amp; زعتر &lt;لتر&gt;</g:title>');
    expect(xmlWellFormed(xml)).toBeNull();
  });
  it('strips characters XML 1.0 forbids instead of producing an unparseable file', () => {
    expect(xmlEscape('a\u0000b\u0008c\uD800d')).toBe('abcd');
  });
  it('a generated feed has ZERO Google violations', () => {
    expect(validateGoogleFeed(feedXml(items))).toEqual([]);
    // Meta's file differs only in the availability words
    expect(
      validateGoogleFeed(
        feedXml(items, 'meta').replace(/<g:availability>in stock/g, '<g:availability>in_stock')
      )
    ).toEqual([]);
  });
  it('the validator is not vacuous: it flags a broken item', () => {
    const bad = feedXml(items)
      .replace(
        '<g:availability>in_stock</g:availability>',
        '<g:availability>maybe</g:availability>'
      )
      .replace(/<g:gtin>\d+<\/g:gtin>/, '<g:gtin>4006381333932</g:gtin>');
    const rules = validateGoogleFeed(bad).map(v => v.rule);
    expect(rules).toContain('availability "maybe" not allowed');
    expect(rules).toContain('gtin fails the GS1 checksum');
    expect(
      validateGoogleFeed(
        '<?xml version="1.0"?><rss><channel><item><g:id>a & b</g:id></item></channel></rss>'
      )[0].rule
    ).toMatch(/not well-formed/);
  });
  it('platform availability words', () => {
    const backorder = items.find(i => i.availability === 'backorder')!;
    expect(itemXml(backorder, 'google')).toContain('<g:availability>backorder</g:availability>');
    expect(itemXml(backorder, 'meta')).toContain('<g:availability>in stock</g:availability>');
    expect(itemCsvRow(backorder)).toContain('"available for order"');
    expect(itemXml(items[0], 'meta')).not.toContain('in_stock');
  });
  it('TikTok CSV: sku_id first, RFC 4180 quoting, formula injection neutralised, 3-level category', () => {
    expect(tiktokHeaderRow().startsWith('sku_id,title,')).toBe(true);
    const row = itemCsvRow(items[0]);
    expect(row.startsWith('"prod-simple","زيت زيتون & زعتر <لتر>"')).toBe(true);
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('125.00 EGP')).toBe('"125.00 EGP"');
    const catRow = itemCsvRow({
      ...items[0],
      googleCategory: {
        id: 479,
        path: 'Health & Beauty > Personal Care > Cosmetics > Perfume & Cologne',
      },
    });
    expect(catRow).toContain('"Health & Beauty > Personal Care > Cosmetics"');
  });
});
