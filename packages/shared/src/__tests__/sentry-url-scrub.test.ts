import { describe, it, expect } from 'vitest';
import {
  scrubPostHogCapture,
  redactSensitiveQuery,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '../utils/sentry-url-scrub';

const PHONE = '01012345678';
const PHONE_AR_ENC = encodeURIComponent('٠١٠١٢٣٤٥٦٧٨');

describe('redactSensitiveQuery', () => {
  it('scrubs a ?q= inside a quoted href of a posthog $elements_chain string', () => {
    const chain = `a:attr__href="/search?q=${PHONE}"nth-child="1"nth-of-type="1"`;
    expect(redactSensitiveQuery(chain)).toBe(
      'a:attr__href="/search?q=[Filtered]"nth-child="1"nth-of-type="1"'
    );
  });

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

describe("apostrophes never end a value (encodeURIComponent leaves ' raw; Franco-Arabic uses it)", () => {
  // Final review C1: a value that stopped at `'` leaked everything after it.
  const enc = encodeURIComponent;
  it.each([
    [`/search?q=O'Brien%20${PHONE}`, '/search?q=[Filtered]'],
    [`/search?page=2&q='${PHONE}`, '/search?page=2&q=[Filtered]'],
    [
      `/api/v1/public/search/suggest?q=${enc("o'brien@mail.com")}`,
      '/api/v1/public/search/suggest?q=[Filtered]',
    ],
    [`/search?q=${enc(`3'ada2 ${PHONE}`)}&sort=newest`, '/search?q=[Filtered]&sort=newest'],
    [`/search?q=${enc(`7'aled ${PHONE}`)}`, '/search?q=[Filtered]'],
    [`/products?search=${enc(`ma7'zan 3'ali ${PHONE}`)}`, '/products?search=[Filtered]'],
  ])('%s', (input, out) => {
    expect(redactSensitiveQuery(input)).toBe(out);
    expect(redactSensitiveQuery(input)).not.toContain(PHONE.slice(3));
  });

  it('element-chain href with an apostrophe inside the quoted value', () => {
    const chain = `a:attr__href="/search?q=o'brien%20${PHONE}"nth-child="1"`;
    expect(redactSensitiveQuery(chain)).toBe('a:attr__href="/search?q=[Filtered]"nth-child="1"');
  });

  it('every SDK surface: request.url, query_string forms, breadcrumbs, spans, transaction', () => {
    const v = `O'Brien%20${PHONE}`;
    const event = {
      transaction: `GET /search?q=${v}`,
      request: { url: `https://shop.ebda.app/search?q=${v}`, query_string: `q='${PHONE}&page=1` },
      breadcrumbs: [
        { category: 'navigation', data: { from: '/', to: `/search?q=3'${PHONE}` } },
        { category: 'fetch', data: { url: `https://api.ebda.app/suggest?q=7'${PHONE}` } },
      ],
      spans: [
        {
          description: `GET /x?search=${v}`,
          data: { 'url.full': `/x?search=${v}`, 'http.query': `?q='${PHONE}` },
        },
      ],
    };
    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(PHONE);
    const pairs = scrubSentryEvent({ request: { query_string: [['q', `O'Brien ${PHONE}`]] } });
    expect(JSON.stringify(pairs)).not.toContain(PHONE);
    const obj = scrubSentryEvent({ request: { query_string: { q: `'${PHONE}` } } });
    expect(JSON.stringify(obj)).not.toContain(PHONE);
    const crumb = scrubSentryBreadcrumb({
      category: 'fetch',
      data: { url: `/suggest?q=o'brien%40x.com` },
    });
    expect(crumb.data.url).toBe('/suggest?q=[Filtered]');
  });

  it('posthog $current_url and $elements_chain', () => {
    const out = scrubPostHogCapture({
      event: '$autocapture',
      properties: {
        $current_url: `https://shop.ebda.app/search?q=3'${PHONE}`,
        $elements_chain: `a:attr__href="/search?q=O'Brien%20${PHONE}"nth-child="1"`,
      },
    })!;
    expect(JSON.stringify(out)).not.toContain(PHONE);
  });
});

describe('array keys (q[] / q%5B%5D / q[0])', () => {
  it.each([
    [`/x?q[]=${PHONE}&page=1`, '/x?q[]=[Filtered]&page=1'],
    [`/x?q%5B%5D=${PHONE}`, '/x?q%5B%5D=[Filtered]'],
    [`/x?search[0]=${PHONE}`, '/x?search[0]=[Filtered]'],
  ])('%s', (input, out) => expect(redactSensitiveQuery(input)).toBe(out));

  it('query_string pairs and object with an array key', () => {
    expect(
      scrubSentryEvent({ request: { query_string: [['q[]', PHONE]] } }).request.query_string
    ).toEqual([['q[]', '[Filtered]']]);
    expect(
      scrubSentryEvent({ request: { query_string: { 'q[]': PHONE } } }).request.query_string
    ).toEqual({
      'q[]': '[Filtered]',
    });
  });

  it('look-alike array keys stay', () => {
    expect(redactSensitiveQuery('/x?qq[]=1&page[]=2')).toBe('/x?qq[]=1&page[]=2');
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

describe('copy-on-write for frozen objects', () => {
  it('returns a scrubbed copy instead of throwing, and leaves the frozen original alone', () => {
    const crumb = Object.freeze({
      category: 'navigation',
      data: Object.freeze({ to: `/search?q=${PHONE}`, from: '/' }),
    });
    let out: typeof crumb | undefined;
    expect(() => {
      out = scrubSentryBreadcrumb(crumb);
    }).not.toThrow();
    expect(out!.data.to).toBe('/search?q=[Filtered]');
    expect(out!.data.from).toBe('/');
    expect(crumb.data.to).toBe(`/search?q=${PHONE}`); // original untouched
    const evt = Object.freeze({
      request: Object.freeze({ query_string: Object.freeze({ q: PHONE }) }),
    });
    expect(scrubSentryEvent(evt).request.query_string).toEqual({ q: '[Filtered]' });
  });

  it('an unchanged object is returned as is (no needless copy)', () => {
    const e = Object.freeze({ url: '/p?page=2' });
    expect(scrubSentryEvent(e)).toBe(e);
  });
});

describe('scrubPostHogCapture', () => {
  it('scrubs $current_url, $referrer and $set_once initial URLs; null passes through', () => {
    const cr = {
      event: '$pageview',
      properties: {
        $current_url: `https://shop.ebda.app/search?q=${PHONE}`,
        $pathname: '/search',
        $referrer: `https://shop.ebda.app/products?search=${PHONE}`,
      },
      $set_once: { $initial_current_url: `https://shop.ebda.app/search?q=${PHONE}` },
    };
    const out = scrubPostHogCapture(cr)!;
    expect(JSON.stringify(out)).not.toContain(PHONE);
    expect(out.properties.$current_url).toBe('https://shop.ebda.app/search?q=[Filtered]');
    expect(scrubPostHogCapture(null)).toBeNull();
  });
});

describe('the X-Search-Query request header (Ruling SEARCH-URL-1)', () => {
  it('is redacted wherever an SDK records request headers, in any case', () => {
    const evt = {
      request: {
        url: 'https://api.ebda.app/api/v1/public/products',
        headers: { 'X-Search-Query': encodeURIComponent(PHONE), accept: 'application/json' },
      },
      extra: { headers: { 'x-search-query': PHONE, host: 'api.ebda.app' } },
    };
    const out = scrubSentryEvent(evt);
    expect(JSON.stringify(out)).not.toContain(PHONE);
    expect(out.request.headers['X-Search-Query']).toBe('[Filtered]');
    expect(out.extra.headers['x-search-query']).toBe('[Filtered]');
    expect(out.request.headers.accept).toBe('application/json');
    expect(out.extra.headers.host).toBe('api.ebda.app');
  });
});

describe('x-hop-timing operator token', () => {
  it('is redacted wherever a request header map is recorded', () => {
    const ev = scrubSentryEvent({
      request: { headers: { 'x-hop-timing': 'secret-token-value', accept: 'x' } },
    });
    expect(JSON.stringify(ev)).not.toContain('secret-token-value');
    expect((ev as any).request.headers.accept).toBe('x');
  });
});

describe('RL-SSR-IP-6: forwarded shopper address + its HMAC', () => {
  it('are redacted wherever a request header map is recorded (any case)', () => {
    const ev = scrubSentryEvent({
      request: {
        headers: {
          'X-Ebda-Client-IP': '203.0.113.7',
          'x-ebda-ssr-auth': 'f'.repeat(64),
          accept: 'x',
        },
      },
    });
    const s = JSON.stringify(ev);
    expect(s).not.toContain('203.0.113.7');
    expect(s).not.toContain('f'.repeat(64));
    expect((ev as any).request.headers.accept).toBe('x');
  });
});

describe('SEC-8: secrets in the path', () => {
  const STORE = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const TOKEN = ['not', 'a', 'secret', '0123456789', '0123456789'].join('-');
  it('masks the Bosta webhook token but keeps the store id', async () => {
    const { redactPathSecrets } = await import('../utils/sentry-url-scrub');
    expect(redactPathSecrets(`/api/v1/webhooks/shipping/bosta/${STORE}/${TOKEN}`)).toBe(
      `/api/v1/webhooks/shipping/bosta/${STORE}/[Filtered]`
    );
    // even a short or letters-only token on that route is masked
    expect(redactPathSecrets(`/webhooks/shipping/bosta/${STORE}/short`)).toBe(
      `/webhooks/shipping/bosta/${STORE}/[Filtered]`
    );
  });
  it('masks any other 24+ char token-like segment, not UUIDs, slugs or short ids', async () => {
    const { redactPathSecrets } = await import('../utils/sentry-url-scrub');
    expect(redactPathSecrets(`/x/${TOKEN}/y`)).toBe('/x/[Filtered]/y');
    expect(redactPathSecrets(`/stores/${STORE}/orders`)).toBe(`/stores/${STORE}/orders`);
    expect(redactPathSecrets('/blog/a-very-long-readable-blog-post-slug')).toBe(
      '/blog/a-very-long-readable-blog-post-slug'
    );
    expect(redactPathSecrets('/api/v1/products/123')).toBe('/api/v1/products/123');
  });
  it('Sentry/PostHog scrub masks the Bosta token but keeps long product slugs readable', () => {
    const slug = '/products/samsung-galaxy-s24-ultra-512gb';
    expect(redactSensitiveQuery(slug)).toBe(slug);
    expect(redactSensitiveQuery(`/x/${TOKEN}/y`)).toBe(`/x/${TOKEN}/y`);
  });
  it('is applied by redactSensitiveQuery and scrubSentryEvent too', () => {
    const url = `/webhooks/shipping/bosta/${STORE}/${TOKEN}?x=1`;
    expect(redactSensitiveQuery(url)).not.toContain(TOKEN);
    const ev = scrubSentryEvent({ request: { url: `https://api.ebda.app${url}` } });
    expect(JSON.stringify(ev)).not.toContain(TOKEN);
  });
});
