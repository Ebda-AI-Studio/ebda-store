import { describe, it, expect } from 'vitest';
import { productJsonLd, shippingDetailsJsonLd } from '../structured-data';

/**
 * Agent-readable commerce fields on Product JSON-LD.
 *
 * An AI shopping agent filters on delivery cost, delivery time and return
 * window before it looks at anything else. Ebda had the underlying data
 * (ShippingZone rows, store identity) but no machine-readable surface for it.
 *
 * The governing rule in every test below: a field is emitted ONLY when real
 * merchant data backs it. Publishing a guessed shipping rate or return window
 * is a false claim about the merchant's business, so omission is always the
 * correct fallback.
 */

const store = {
  id: 's1',
  name: 'Demo Store',
  slug: 'demo-store',
  currency: 'EGP',
  status: 'active',
  timezone: 'Africa/Cairo',
  template: 'qamar',
  theme: {},
  socialLinks: {},
} as never;

const product = { name: 'Pecan Mix', slug: 'pecan-mix', price: 5000, inventory: 10 } as never;

describe('productJsonLd — agent-readable fields', () => {
  it('emits brand from the store name', () => {
    const ld = productJsonLd(product, store) as unknown as Record<string, unknown>;
    expect(ld.brand).toEqual({ '@type': 'Brand', name: 'Demo Store' });
  });
});

describe('shippingDetailsJsonLd', () => {
  const zone = {
    name: 'Cairo',
    deliveryFee: 1500,
    freeShippingThreshold: 20000,
    estimatedDaysMin: 1,
    estimatedDaysMax: 3,
    estimatedDays: null,
  };

  it('advertises the CHEAPEST zone rate and converts piastres to EGP', () => {
    const dear = { ...zone, name: 'Far', deliveryFee: 4000 };
    const out = shippingDetailsJsonLd([dear, zone], { currency: 'EGP' })!;
    expect(out.shippingRate).toMatchObject({ value: '15.00', currency: 'EGP' });
  });

  it('emits a delivery time window from min/max days', () => {
    const out = shippingDetailsJsonLd([zone], { currency: 'EGP' })!;
    expect(out.deliveryTime?.transitTime).toMatchObject({ minValue: 1, maxValue: 3 });
  });

  it('falls back to a flat estimatedDays when min/max are absent', () => {
    const flat = { ...zone, estimatedDaysMin: null, estimatedDaysMax: null, estimatedDays: 2 };
    const out = shippingDetailsJsonLd([flat], { currency: 'EGP' })!;
    expect(out.deliveryTime?.transitTime).toMatchObject({ minValue: 2, maxValue: 2 });
  });

  it('omits deliveryTime when the merchant set no estimate at all', () => {
    const noEta = {
      ...zone,
      estimatedDaysMin: null,
      estimatedDaysMax: null,
      estimatedDays: null,
    };
    expect(shippingDetailsJsonLd([noEta], { currency: 'EGP' })).not.toHaveProperty('deliveryTime');
  });

  it('returns null for no zones rather than implying free shipping', () => {
    // A 0 rate here would claim free delivery we cannot honour at checkout.
    expect(shippingDetailsJsonLd([], { currency: 'EGP' })).toBeNull();
  });
});

describe('productJsonLd — shippingDetails wiring', () => {
  const zones = [
    {
      name: 'Cairo',
      deliveryFee: 1500,
      freeShippingThreshold: null,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      estimatedDays: null,
    },
  ];

  it('nests shippingDetails inside offers when zones are supplied', () => {
    const ld = productJsonLd(product, store, { shippingZones: zones }) as unknown as {
      offers: Record<string, unknown>;
    };
    expect(ld.offers.shippingDetails).toMatchObject({ '@type': 'OfferShippingDetails' });
  });

  it('omits shippingDetails when no zones are supplied', () => {
    const ld = productJsonLd(product, store) as unknown as { offers: Record<string, unknown> };
    expect(ld.offers).not.toHaveProperty('shippingDetails');
  });
});

describe('merchantReturnPolicyJsonLd', () => {
  it('omits the policy entirely when the merchant declared no window', () => {
    // Silence is honest. A default here would publish a return commitment
    // on behalf of a merchant who never agreed to one.
    const ld = productJsonLd(product, store) as unknown as Record<string, unknown>;
    expect(ld).not.toHaveProperty('hasMerchantReturnPolicy');
  });

  it('emits a finite window when one is set', () => {
    const s = { ...(store as object), returnWindowDays: 14, returnFeesPaidBy: 'customer' } as never;
    const ld = productJsonLd(product, s) as unknown as Record<string, unknown>;
    expect(ld.hasMerchantReturnPolicy).toMatchObject({
      '@type': 'MerchantReturnPolicy',
      merchantReturnDays: 14,
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      returnFees: 'https://schema.org/ReturnShippingFees',
    });
  });

  it('marks merchant-paid returns as FreeReturn', () => {
    const s = { ...(store as object), returnWindowDays: 30, returnFeesPaidBy: 'merchant' } as never;
    const ld = productJsonLd(product, s) as unknown as Record<string, unknown>;
    expect(ld.hasMerchantReturnPolicy).toMatchObject({
      returnFees: 'https://schema.org/FreeReturn',
    });
  });

  it('treats 0 as "returns not accepted", NOT as a zero-day window', () => {
    const s = { ...(store as object), returnWindowDays: 0 } as never;
    const ld = productJsonLd(product, s) as unknown as Record<string, unknown>;
    expect(ld.hasMerchantReturnPolicy).toMatchObject({
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    });
    expect(ld.hasMerchantReturnPolicy).not.toHaveProperty('merchantReturnDays');
  });
});

describe('Product JSON-LD images (audit M-170)', () => {
  const img = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://media.ebda.app/p${i}.webp` }));
  it('one image stays a plain string', () => {
    const ld = productJsonLd({ ...(product as object), images: img(1) } as never, store) as {
      image: unknown;
    };
    expect(ld.image).toBe('https://media.ebda.app/p0.webp');
  });
  it('a gallery lists every image, at most 10', () => {
    const ld = productJsonLd({ ...(product as object), images: img(3) } as never, store) as {
      image: unknown;
    };
    expect(ld.image).toEqual(img(3).map(i => i.url));
    const many = productJsonLd({ ...(product as object), images: img(14) } as never, store) as {
      image: string[];
    };
    expect(many.image).toHaveLength(10);
  });
  it('no images, no image field', () => {
    const ld = productJsonLd(product, store) as Record<string, unknown>;
    expect('image' in ld).toBe(false);
  });
});

describe('productJsonLd — 3D model (subjectOf 3DModel)', () => {
  const withModel = (model3d: unknown) => ({ ...(product as object), model3d }) as never;
  it('emits a 3DModel subjectOf with the GLB url', () => {
    const ld = productJsonLd(withModel({ modelUrl: 'https://media.ebda.app/m.glb' }), store) as {
      subjectOf: Record<string, string>;
    };
    expect(ld.subjectOf).toMatchObject({
      '@type': '3DModel',
      encodingFormat: 'model/gltf-binary',
      contentUrl: 'https://media.ebda.app/m.glb',
    });
  });
  it('adds the USDZ as a second node only when uploaded', () => {
    const ld = productJsonLd(
      withModel({ modelUrl: 'https://m/a.glb', usdzUrl: 'https://m/a.usdz' }),
      store
    ) as { subjectOf: Array<Record<string, string>> };
    expect(ld.subjectOf.map(n => n.encodingFormat)).toEqual([
      'model/gltf-binary',
      'model/vnd.usdz+zip',
    ]);
  });
  it('omits subjectOf with no model, or a model without a url', () => {
    expect(productJsonLd(product, store)).not.toHaveProperty('subjectOf');
    expect(productJsonLd(withModel(null), store)).not.toHaveProperty('subjectOf');
    expect(productJsonLd(withModel({ modelUrl: '' }), store)).not.toHaveProperty('subjectOf');
  });
});
