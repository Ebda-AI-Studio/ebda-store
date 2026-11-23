import type {
  FeedProductRow,
  FeedStoreInfo,
  BuildContext,
} from '../../apps/api/src/lib/catalogue-feed/build';

export const store: FeedStoreInfo = {
  name: 'Nile Gifts',
  nameAr: 'هدايا النيل',
  currency: 'EGP',
  origin: 'https://nile.ebda.app',
  flatShippingMinor: null,
};

export const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({
  store,
  lang: 'ar',
  backorderOn: false,
  categoryById: new Map([
    ['c-clothes', { name: 'Clothing', nameAr: 'ملابس', parentId: null }],
    ['c-dress', { name: 'Dresses', nameAr: 'فساتين', parentId: 'c-clothes' }],
    ['c-misc', { name: 'Misc', nameAr: 'متنوع', parentId: null }],
  ]),
  ...over,
});

const img = (n: number) => ({ url: `https://cdn.example/p${n}.jpg`, position: n });

/** A simple product with a sale, a valid EAN-13 and an Arabic title containing & < >. */
export const simple = (over: Partial<FeedProductRow> = {}): FeedProductRow => ({
  id: 'prod-simple',
  name: 'Olive Oil & Thyme <1L>',
  nameAr: 'زيت زيتون & زعتر <لتر>',
  slug: 'olive-oil',
  description: '<p>Cold   pressed.</p>',
  descriptionAr: 'عصرة أولى.',
  price: 12500,
  compareAtPrice: 15000,
  barcode: '4006381333931', // valid EAN-13
  inventory: 4,
  trackInventory: true,
  images: [img(1), img(0), img(2)],
  categories: [
    { category: { id: 'c-misc', name: 'Misc', nameAr: 'متنوع', slug: 'misc', parentId: null } },
  ],
  options: [],
  variants: [],
  ...over,
});

/** A variant product: sizes x colours, one out of stock, one inactive, parent has a stale compare-at that must be ignored. */
export const dress = (over: Partial<FeedProductRow> = {}): FeedProductRow => ({
  id: 'prod-dress',
  name: 'Linen Dress',
  nameAr: 'فستان كتان',
  slug: 'linen-dress',
  description: 'Soft linen.',
  price: 80000,
  compareAtPrice: 99900, // stale parent compare-at: variants decide
  inventory: 0,
  trackInventory: true,
  images: [img(0)],
  categories: [
    {
      category: {
        id: 'c-dress',
        name: 'Dresses',
        nameAr: 'فساتين',
        slug: 'dresses',
        parentId: 'c-clothes',
      },
    },
  ],
  options: [
    {
      name: 'Size',
      nameAr: 'المقاس',
      values: [
        { id: 'sz-m', value: 'M', valueAr: 'متوسط' },
        { id: 'sz-l', value: 'L', valueAr: 'كبير' },
      ],
    },
    { name: 'Color', nameAr: 'اللون', values: [{ id: 'co-r', value: 'Red', valueAr: 'أحمر' }] },
  ],
  variants: [
    {
      id: 'var-m-red',
      title: 'M / Red',
      titleAr: 'متوسط / أحمر',
      price: 80000,
      compareAtPrice: 100000,
      inventory: 3,
      isActive: true,
      barcode: '123',
      optionValueIds: ['sz-m', 'co-r'],
      imageUrl: 'https://cdn.example/red.jpg',
    },
    {
      id: 'var-l-red',
      title: 'L / Red',
      titleAr: 'كبير / أحمر',
      price: null,
      compareAtPrice: null,
      inventory: 0,
      isActive: true,
      allowBackorder: true,
      optionValueIds: ['sz-l', 'co-r'],
    },
    {
      id: 'var-xl-red',
      title: 'XL / Red',
      price: 80000,
      inventory: 5,
      isActive: false,
      optionValueIds: [],
    },
  ],
  ...over,
});
