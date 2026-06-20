import { describe, it, expect } from 'vitest';
import {
  breadcrumbJsonLd,
  itemList,
  storeJsonLd,
  faqPageJsonLd,
  howToJsonLd,
  aggregateRatingJsonLd,
  reviewJsonLd,
} from '@web/lib/structured-data';

describe('breadcrumbJsonLd', () => {
  it('builds positioned ListItem array', () => {
    const r = breadcrumbJsonLd([
      { name: 'Home', url: 'https://example.com' },
      { name: 'Products', url: 'https://example.com/products' },
    ]) as any;
    expect(r['@type']).toBe('BreadcrumbList');
    expect(r['@context']).toBe('https://schema.org');
    expect(r.itemListElement).toHaveLength(2);
    expect(r.itemListElement[0].position).toBe(1);
    expect(r.itemListElement[0].name).toBe('Home');
    expect(r.itemListElement[0].item).toBe('https://example.com');
    expect(r.itemListElement[1].position).toBe(2);
  });

  it('handles single-item breadcrumb', () => {
    const r = breadcrumbJsonLd([{ name: 'Home', url: 'https://example.com' }]) as any;
    expect(r.itemListElement).toHaveLength(1);
  });

  it('handles empty array', () => {
    const r = breadcrumbJsonLd([]) as any;
    expect(r.itemListElement).toHaveLength(0);
  });
});

describe('itemList', () => {
  it('formats price from fils to KWD with 3 decimals', () => {
    const r = itemList(
      [{ name: 'Test', url: 'https://example.com/p', price: 1500 }],
      'Featured'
    ) as any;
    expect(r['@type']).toBe('ItemList');
    expect(r.name).toBe('Featured');
    expect(r.numberOfItems).toBe(1);
    expect(r.itemListElement[0].item.offers.price).toBe('1.500');
    expect(r.itemListElement[0].item.offers.priceCurrency).toBe('KWD');
  });

  it('omits offers when no price', () => {
    const r = itemList([{ name: 'T', url: 'u' }]) as any;
    expect(r.itemListElement[0].item.offers).toBeUndefined();
  });

  it('omits offers when price is null', () => {
    const r = itemList([{ name: 'T', url: 'u', price: null }]) as any;
    expect(r.itemListElement[0].item.offers).toBeUndefined();
  });

  it('marks OutOfStock when inStock=false', () => {
    const r = itemList([{ name: 'T', url: 'u', price: 100, inStock: false }]) as any;
    expect(r.itemListElement[0].item.offers.availability).toBe('https://schema.org/OutOfStock');
  });

  it('marks InStock by default', () => {
    const r = itemList([{ name: 'T', url: 'u', price: 100 }]) as any;
    expect(r.itemListElement[0].item.offers.availability).toBe('https://schema.org/InStock');
  });

  it('omits listName when not provided', () => {
    const r = itemList([{ name: 'T', url: 'u' }]) as any;
    expect(r.name).toBeUndefined();
  });

  it('uses custom currency when provided', () => {
    const r = itemList([{ name: 'T', url: 'u', price: 500, currency: 'USD' }]) as any;
    expect(r.itemListElement[0].item.offers.priceCurrency).toBe('USD');
  });

  it('includes image when provided', () => {
    const r = itemList([{ name: 'T', url: 'u', image: 'img.jpg' }]) as any;
    expect(r.itemListElement[0].item.image).toBe('img.jpg');
  });

  it('positions multiple items correctly', () => {
    const r = itemList([
      { name: 'A', url: 'u1' },
      { name: 'B', url: 'u2' },
      { name: 'C', url: 'u3' },
    ]) as any;
    expect(r.itemListElement[0].position).toBe(1);
    expect(r.itemListElement[1].position).toBe(2);
    expect(r.itemListElement[2].position).toBe(3);
    expect(r.numberOfItems).toBe(3);
  });
});

describe('storeJsonLd', () => {
  it('emits Store type with required fields', () => {
    const r = storeJsonLd({ name: 'MyStore', url: 'https://x.com' }) as any;
    expect(r['@type']).toBe('Store');
    expect(r['@context']).toBe('https://schema.org');
    expect(r.name).toBe('MyStore');
    expect(r.url).toBe('https://x.com');
  });

  it('emits PostalAddress with Kuwait default', () => {
    const r = storeJsonLd({ name: 'Wady', url: 'https://x', address: 'Hawalli' }) as any;
    expect(r.address['@type']).toBe('PostalAddress');
    expect(r.address.streetAddress).toBe('Hawalli');
    expect(r.address.addressCountry).toBe('KW');
  });

  it('emits sameAs only when social array is non-empty', () => {
    const a = storeJsonLd({ name: 'X', url: 'u' }) as any;
    expect(a.sameAs).toBeUndefined();

    const b = storeJsonLd({
      name: 'X',
      url: 'u',
      social: ['https://instagram.com/x', 'https://wikidata.org/wiki/Q1'],
    }) as any;
    expect(b.sameAs).toHaveLength(2);
  });

  it('omits sameAs for empty social array', () => {
    const r = storeJsonLd({ name: 'X', url: 'u', social: [] }) as any;
    expect(r.sameAs).toBeUndefined();
  });

  it('emits logo + image when logo provided', () => {
    const r = storeJsonLd({ name: 'X', url: 'u', logo: 'logo.png' }) as any;
    expect(r.logo).toBe('logo.png');
    expect(r.image).toBe('logo.png');
  });

  it('emits inLanguage when provided', () => {
    const r = storeJsonLd({ name: 'X', url: 'u', inLanguage: 'ar' }) as any;
    expect(r.inLanguage).toBe('ar');
  });
});

describe('faqPageJsonLd', () => {
  it('wraps Q/A pairs in Question/Answer types', () => {
    const r = faqPageJsonLd([{ question: 'When?', answer: 'Today.' }]) as any;
    expect(r['@type']).toBe('FAQPage');
    expect(r['@context']).toBe('https://schema.org');
    expect(r.mainEntity).toHaveLength(1);
    expect(r.mainEntity[0]['@type']).toBe('Question');
    expect(r.mainEntity[0].name).toBe('When?');
    expect(r.mainEntity[0].acceptedAnswer['@type']).toBe('Answer');
    expect(r.mainEntity[0].acceptedAnswer.text).toBe('Today.');
  });

  it('handles multiple FAQs', () => {
    const r = faqPageJsonLd([
      { question: 'Q1?', answer: 'A1.' },
      { question: 'Q2?', answer: 'A2.' },
    ]) as any;
    expect(r.mainEntity).toHaveLength(2);
  });
});

describe('howToJsonLd', () => {
  it('positions steps + propagates name/text/image', () => {
    const r = howToJsonLd({
      name: 'Test',
      description: 'D',
      steps: [
        { name: 'A', text: 'do a' },
        { name: 'B', text: 'do b', image: 'img.jpg' },
      ],
    }) as any;
    expect(r['@type']).toBe('HowTo');
    expect(r['@context']).toBe('https://schema.org');
    expect(r.step).toHaveLength(2);
    expect(r.step[0].position).toBe(1);
    expect(r.step[0]['@type']).toBe('HowToStep');
    expect(r.step[0].image).toBeUndefined();
    expect(r.step[1].position).toBe(2);
    expect(r.step[1].image).toBe('img.jpg');
  });

  it('includes totalTime when provided', () => {
    const r = howToJsonLd({
      name: 'T',
      description: 'D',
      steps: [{ name: 'S', text: 't' }],
      totalTime: 'PT5M',
    }) as any;
    expect(r.totalTime).toBe('PT5M');
  });

  it('omits totalTime when not provided', () => {
    const r = howToJsonLd({ name: 'T', description: 'D', steps: [] }) as any;
    expect(r.totalTime).toBeUndefined();
  });
});

describe('aggregateRatingJsonLd', () => {
  it('rounds to 1 decimal', () => {
    const r = aggregateRatingJsonLd({ ratingValue: 4.55555, reviewCount: 100 }) as any;
    expect(r.ratingValue).toBe('4.6');
  });

  it('uses default bestRating/worstRating when not provided', () => {
    const r = aggregateRatingJsonLd({ ratingValue: 4.0, reviewCount: 10 }) as any;
    expect(r.bestRating).toBe(5);
    expect(r.worstRating).toBe(1);
  });

  it('respects custom bestRating/worstRating', () => {
    const r = aggregateRatingJsonLd({
      ratingValue: 8.0,
      reviewCount: 50,
      bestRating: 10,
      worstRating: 0,
    }) as any;
    expect(r.bestRating).toBe(10);
    expect(r.worstRating).toBe(0);
  });

  it('emits correct type and reviewCount', () => {
    const r = aggregateRatingJsonLd({ ratingValue: 3.0, reviewCount: 42 }) as any;
    expect(r['@type']).toBe('AggregateRating');
    expect(r.reviewCount).toBe(42);
  });
});

describe('reviewJsonLd', () => {
  it('emits Author + Rating + body', () => {
    const r = reviewJsonLd({
      author: 'Ahmad',
      rating: 5,
      body: 'Great',
      datePublished: '2026-05-12',
    }) as any;
    expect(r['@type']).toBe('Review');
    expect(r.author['@type']).toBe('Person');
    expect(r.author.name).toBe('Ahmad');
    expect(r.reviewRating['@type']).toBe('Rating');
    expect(r.reviewRating.ratingValue).toBe(5);
    expect(r.reviewRating.bestRating).toBe(5);
    expect(r.reviewRating.worstRating).toBe(1);
    expect(r.reviewBody).toBe('Great');
    expect(r.datePublished).toBe('2026-05-12');
  });

  it('includes inLanguage when provided', () => {
    const r = reviewJsonLd({
      author: 'Ahmad',
      rating: 4,
      body: 'جيد',
      datePublished: '2026-05-12',
      inLanguage: 'ar',
    }) as any;
    expect(r.inLanguage).toBe('ar');
  });

  it('omits inLanguage when not provided', () => {
    const r = reviewJsonLd({
      author: 'Ahmad',
      rating: 4,
      body: 'Good',
      datePublished: '2026-05-12',
    }) as any;
    expect(r.inLanguage).toBeUndefined();
  });
});
