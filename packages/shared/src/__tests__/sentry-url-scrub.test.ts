import { describe, it, expect } from 'vitest';
import {
  redactSensitiveQuery,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '../utils/sentry-url-scrub';

const PHONE = '01012345678';
const PHONE_AR_ENC = encodeURIComponent('٠١٠١٢٣٤٥٦٧٨');

describe('redactSensitiveQuery', () => {
  it.each([
    [
      `/api/v1/public/products?search=${PHONE}&page=1`,
      '/api/v1/public/products?search=[Filtered]&page=1',
    ],
    [`https://shop.ebda.app/search?q=${PHONE_AR_ENC}`, 'https://shop.ebda.app/search?q=[Filtered]'],
    [`/x?page=2&SEARCH=${PHONE}#top`, '/x?page=2&SEARCH=[Filtered]#top'],
    [`search=${PHONE}&sort=newest`, 'search=[Filtered]&sort=newest'], // bare query string
    ['/c?email=a%40b.com&phone=%2B201012345678', '/c?email=[Filtered]&phone=[Filtered]'],
    [
      '/x?query=a&term=b&keyword=c&keywords=d',
      '/x?query=[Filtered]&term=[Filtered]&keyword=[Filtered]&keywords=[Filtered]',
    ],
    [
      `Cannot GET /api/v1/public/products?search=${PHONE}`,
      'Cannot GET /api/v1/public/products?search=[Filtered]',
    ],
  ])('%s', (input, out) => expect(redactSensitiveQuery(input)).toBe(out));

  it('keeps non-sensitive params, empty values and look-alike keys', () => {
    for (const keep of [
      '/p?page=2&sort=price_asc&category=shoes',
      '/p?search=&page=1',
      '/p?research=1&qq=2&searchable=yes',
      '/plain/path',
    ]) {
      expect(redactSensitiveQuery(keep)).toBe(keep);
    }
  });
});

describe('scrubSentryEvent', () => {
  it('removes a phone typed into ?search= from every place an SDK puts the URL', () => {
    const event = {
      transaction: `GET /api/v1/public/products?search=${PHONE}`,
      request: {
        url: `https://api.ebda.app/api/v1/public/products?search=${PHONE}`,
        query_string: `search=${PHONE}&page=1`,
      },
      breadcrumbs: [
        { category: 'navigation', data: { from: '/', to: `/search?q=${PHONE}` } },
        {
          category: 'fetch',
          data: { url: `https://api.ebda.app/x?search=${PHONE}`, method: 'GET' },
        },
        { category: 'console', message: `loaded /search?q=${PHONE}` },
      ],
      spans: [
        {
          description: `GET /x?search=${PHONE}`,
          data: { 'url.full': `/x?search=${PHONE}`, 'http.query': `?search=${PHONE}` },
        },
      ],
      contexts: { trace: { data: { 'url.query': `search=${PHONE}` } } },
      extra: { url: `/x?q=${PHONE}` },
    };
    const out = scrubSentryEvent(event);
    expect(JSON.stringify(out)).not.toContain(PHONE);
    expect(out.request.url).toBe('https://api.ebda.app/api/v1/public/products?search=[Filtered]');
    expect(out.request.query_string).toBe('search=[Filtered]&page=1');
  });

  it('handles query_string as pairs and as an object', () => {
    const pairs = scrubSentryEvent({
      request: {
        query_string: [
          ['search', PHONE],
          ['page', '1'],
        ],
      },
    });
    expect(pairs.request.query_string).toEqual([
      ['search', '[Filtered]'],
      ['page', '1'],
    ]);
    const obj = scrubSentryEvent({ request: { query_string: { q: PHONE, page: '1' } } });
    expect(obj.request.query_string).toEqual({ q: '[Filtered]', page: '1' });
  });

  it('survives cycles and non-string values', () => {
    const a: Record<string, unknown> = { n: 1, b: true, nil: null, url: `/x?q=${PHONE}` };
    a.self = a;
    expect(() => scrubSentryEvent(a)).not.toThrow();
    expect(a.url).toBe('/x?q=[Filtered]');
  });
});

describe('scrubSentryBreadcrumb', () => {
  it('scrubs an xhr breadcrumb', () => {
    const b = scrubSentryBreadcrumb({ category: 'xhr', data: { url: `/api?search=${PHONE}` } });
    expect(b.data.url).toBe('/api?search=[Filtered]');
  });
});
