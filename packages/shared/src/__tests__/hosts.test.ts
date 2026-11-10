import { describe, it, expect } from 'vitest';
import {
  RESERVED_SLUGS,
  isReservedSlug,
  validateStoreSlug,
  validateStoreSlugFormat,
  storeSlugSchema,
  storeSlugIssueCode,
  parseStoreHost,
  normalizeHost,
  storefrontOrigin,
  storeOrigin,
  BRAND,
  type ParsedStoreHost,
} from '../index';

const sub = (slug: string): ParsedStoreHost => ({ kind: 'subdomain', slug });
const custom = (hostname: string): ParsedStoreHost => ({ kind: 'custom', hostname });
const platform = (app: string): ParsedStoreHost => ({ kind: 'platform', app }) as ParsedStoreHost;
const INVALID: ParsedStoreHost = { kind: 'invalid' };

describe('RESERVED_SLUGS — the single source of truth', () => {
  it('is exactly the program plan §1 list', () => {
    expect([...RESERVED_SLUGS].sort()).toEqual(
      [
        'app',
        'api',
        'docs',
        'help',
        'status',
        'whatsapp',
        'www',
        'admin',
        'orders',
        'mail',
        'cdn',
        'assets',
        'static',
        'store',
        'dashboard',
        'billing',
        'support',
        'blog',
        // suite products + identity (PRODUCT-NAME-1, 2026-10-07)
        'crm',
        'erp',
        'hub',
        'id',
        'accounts',
        'media',
        // Ebda Chat product host (wa.ebda.app)
        'wa',
        // Ebda AI Studio hosts (store-local extension)
        'events',
        'marketing',
        'design',
        'os',
        'studio',
        'checkin',
        'manage',
        // coming-soon software pages (SUBDOMAIN-SOON-2)
        'invite',
        'quote',
      ].sort()
    );
  });

  it.each(['preview-x', 'preview-abc123', 'PREVIEW-Foo', ' preview-1 '])(
    'prefix rule: isReservedSlug(%j) and validateStoreSlug refuse it with SLUG_RESERVED',
    slug => {
      expect(isReservedSlug(slug)).toBe(true);
      const r = validateStoreSlug(slug.trim().toLowerCase());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
      expect(parseStoreHost(`${slug.trim().toLowerCase()}.ebda.app`).kind).not.toBe('subdomain');
    }
  );

  it.each(['previews', 'preview', 'my-preview-shop', 'previewshop'])(
    'prefix rule does not over-match %s',
    slug => {
      expect(isReservedSlug(slug)).toBe(false);
    }
  );

  it.each([...RESERVED_SLUGS])('isReservedSlug(%s)', slug => {
    expect(isReservedSlug(slug)).toBe(true);
    expect(isReservedSlug(slug.toUpperCase())).toBe(true);
    expect(isReservedSlug(` ${slug} `)).toBe(true);
  });

  it.each(['amelia', 'ebda', 'shop', 'apps', 'app-store', 'my-api', '', null, undefined])(
    'isReservedSlug(%j) is false',
    slug => {
      expect(isReservedSlug(slug as string | null | undefined)).toBe(false);
    }
  );
});

describe('store slug validation', () => {
  it.each([
    ['amelia', true],
    ['abc', true], // min length
    ['a'.repeat(40), true], // max length
    ['my-store-2', true],
    ['123', true],
    ['ab', false], // too short
    ['a'.repeat(41), false], // too long
    ['Amelia', false], // uppercase is rejected, not silently lowercased
    ['my_store', false],
    ['my store', false],
    ['متجر', false], // non-ASCII
    ['-store', false], // leading hyphen
    ['store-', false], // trailing hyphen
    ['my--store', false], // double hyphen
    ['xn--abc', false], // double hyphen (punycode label is not a slug)
    ['', false],
  ])('validateStoreSlugFormat(%j) → %s', (slug, ok) => {
    expect(validateStoreSlugFormat(slug).ok).toBe(ok);
  });

  it.each([
    ['ab', 'SLUG_TOO_SHORT'],
    ['a'.repeat(41), 'SLUG_TOO_LONG'],
    ['Amelia', 'SLUG_INVALID_CHARS'],
    ['my store', 'SLUG_INVALID_CHARS'],
    ['-store', 'SLUG_INVALID_HYPHEN'],
    ['store-', 'SLUG_INVALID_HYPHEN'],
    ['my--store', 'SLUG_INVALID_HYPHEN'],
    ['support', 'SLUG_RESERVED'],
    ['api', 'SLUG_RESERVED'],
    ['www', 'SLUG_RESERVED'],
    ['dashboard', 'SLUG_RESERVED'],
  ])('validateStoreSlug(%j) fails with %s', (slug, code) => {
    const result = validateStoreSlug(slug);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('every reserved label is refused with SLUG_RESERVED when it is otherwise well-formed', () => {
    for (const slug of RESERVED_SLUGS) {
      const result = validateStoreSlug(slug);
      expect(result.ok).toBe(false);
      // 2-char reserved labels (e.g. `id`) hit SLUG_TOO_SHORT first — still refused.
      if (!result.ok)
        expect(slug.length < 3 ? ['SLUG_TOO_SHORT', 'SLUG_RESERVED'] : ['SLUG_RESERVED']).toContain(
          result.code
        );
    }
  });

  it('the zod schema carries the machine-readable code on the issue', () => {
    const bad = storeSlugSchema.safeParse('support');
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(storeSlugIssueCode(bad.error.issues[0])).toBe('SLUG_RESERVED');
    }
    expect(storeSlugSchema.safeParse('amelia').success).toBe(true);
    expect(storeSlugIssueCode({ code: 'too_small' })).toBeNull();
  });
});

describe('parseStoreHost', () => {
  const cases: Array<[string, string | null | undefined, ParsedStoreHost]> = [
    // ── store subdomains ──────────────────────────────────────────────────
    ['plain slug subdomain', 'amelia.ebda.app', sub('amelia')],
    ['uppercase + port', 'AMELIA.EBDA.APP:443', sub('amelia')],
    ['trailing dot', 'amelia.ebda.app.', sub('amelia')],
    ['hyphenated slug', 'my-store-2.ebda.app', sub('my-store-2')],
    ['surrounding whitespace', '  amelia.ebda.app  ', sub('amelia')],
    ['40-char slug', `${'a'.repeat(40)}.ebda.app`, sub('a'.repeat(40))],
    // ── platform hosts ────────────────────────────────────────────────────
    ['apex', 'ebda.app', platform('marketing')],
    ['apex with port', 'ebda.app:443', platform('marketing')],
    ['www alias of the apex', 'www.ebda.app', platform('marketing')],
    ['ebda store merchant app', 'store.ebda.app', platform('storeApp')],
    ['api', 'api.ebda.app', platform('api')],
    ['orders pwa', 'orders.ebda.app', platform('orders')],
    ['docs', 'docs.ebda.app', platform('docs')],
    ['help', 'help.ebda.app', platform('help')],
    ['status', 'status.ebda.app', platform('status')],
    ['whatsapp (reserved)', 'whatsapp.ebda.app', platform('whatsapp')],
    ['workers.dev preview', 'ebda-web.acct.workers.dev', platform('preview')],
    // ── reserved labels with no platform surface are never a store ────────
    ['retired admin host (HOST-STORE-1: reserved, no surface)', 'admin.ebda.app', INVALID],
    ['retired app label (never live; reserved, no surface)', 'app.ebda.app', INVALID],
    ['mail label', 'mail.ebda.app', INVALID],
    ['blog label', 'blog.ebda.app', INVALID],
    ['support label', 'support.ebda.app', INVALID],
    // ── malformed under our suffix ────────────────────────────────────────
    ['two labels deep', 'x.y.ebda.app', INVALID],
    ['www under a store', 'www.amelia.ebda.app', INVALID],
    ['too-short slug', 'ab.ebda.app', INVALID],
    ['too-long slug', `${'a'.repeat(41)}.ebda.app`, INVALID],
    ['leading hyphen', '-amelia.ebda.app', INVALID],
    ['double hyphen', 'my--store.ebda.app', INVALID],
    ['empty label', '.ebda.app', INVALID],
    // ── IPs, localhost, junk ──────────────────────────────────────────────
    ['IPv4', '127.0.0.1', INVALID],
    ['IPv4 with port', '10.0.0.5:3000', INVALID],
    ['public IPv4', '8.8.8.8', INVALID],
    ['IPv6 literal', '[::1]', INVALID],
    ['IPv6 literal with port', '[2001:db8::1]:8443', INVALID],
    ['bare IPv6', '::1', INVALID],
    ['localhost', 'localhost', INVALID],
    ['localhost with port', 'localhost:3000', INVALID],
    ['dev suffix is off by default', 'amelia.localhost', INVALID],
    ['dev ebda suffix is off by default', 'amelia.ebda.localhost', INVALID],
    ['empty string', '', INVALID],
    ['whitespace', '   ', INVALID],
    ['null', null, INVALID],
    ['undefined', undefined, INVALID],
    ['single label', 'intranet', INVALID],
    ['userinfo', 'user@evil.example', INVALID],
    ['path smuggled in', 'amelia.ebda.app/evil', INVALID],
    ['space inside', 'ame lia.ebda.app', INVALID],
    ['non-ASCII (must arrive as punycode)', 'ameília.ebda.app', INVALID],
    ['empty label in the middle', 'a..b.com', INVALID],
    ['numeric TLD', 'example.123', INVALID],
    // ── custom domains ────────────────────────────────────────────────────
    ['custom apex', 'ameliaaurum.com', custom('ameliaaurum.com')],
    ['custom with port + case', 'AmeliaAurum.COM:8443', custom('ameliaaurum.com')],
    ['custom with trailing dot', 'ameliaaurum.com.', custom('ameliaaurum.com')],
    ['custom www is still a custom host', 'www.ameliaaurum.com', custom('www.ameliaaurum.com')],
    ['custom subdomain', 'shop.example.co.uk', custom('shop.example.co.uk')],
    [
      'punycode (IDN) custom domain',
      'xn--mgbh0fb.xn--mgberp4a5d4ar',
      custom('xn--mgbh0fb.xn--mgberp4a5d4ar'),
    ],
    [
      'punycode label inside a latin domain',
      'xn--bcher-kva.example',
      custom('xn--bcher-kva.example'),
    ],
    // Look-alikes of OUR domain are just other people's custom domains: the
    // resolver finds no store for them and 404s.
    ['ebda.app as a prefix of another domain', 'ebda.app.evil.com', custom('ebda.app.evil.com')],
    ['evil-ebda.app', 'evil-ebda.app', custom('evil-ebda.app')],
    ['notebda.app', 'notebda.app', custom('notebda.app')],
  ];

  it.each(cases)('%s: %j', (_name, host, expected) => {
    expect(parseStoreHost(host)).toEqual(expected);
  });

  describe('dev suffixes (explicit opt-in only)', () => {
    const dev = { allowDevSuffixes: true };
    it.each<[string, ParsedStoreHost]>([
      ['amelia.ebda.localhost', sub('amelia')],
      ['amelia.ebda.localhost:3000', sub('amelia')],
      ['AMELIA.LOCALHOST:3000', sub('amelia')],
      ['amelia.localhost', sub('amelia')],
      // still not a store, even in dev
      ['localhost', INVALID],
      ['localhost:3000', INVALID],
      ['127.0.0.1', INVALID],
      ['app.localhost', INVALID], // reserved labels have no dev surface
      ['x.y.localhost', INVALID],
      ['ab.localhost', INVALID], // slug rules still apply
      // production hosts parse identically with the flag on
      ['amelia.ebda.app', sub('amelia')],
      ['ebda.app', platform('marketing')],
      ['ameliaaurum.com', custom('ameliaaurum.com')],
    ])('%s (dev on)', (host, expected) => {
      expect(parseStoreHost(host, dev)).toEqual(expected);
    });
  });

  it('is total: it never throws and never defaults to a store', () => {
    for (const junk of ['\u0000', '%00', '.', '..', ':', ':::', '😀.com', 'a'.repeat(300)]) {
      expect(() => parseStoreHost(junk)).not.toThrow();
      expect(parseStoreHost(junk).kind).not.toBe('subdomain');
    }
  });

  it('every reserved label under our suffix is never a store subdomain', () => {
    for (const label of RESERVED_SLUGS) {
      const parsed = parseStoreHost(`${label}.ebda.app`);
      expect(parsed.kind).not.toBe('subdomain');
      expect(parsed.kind).not.toBe('custom');
    }
  });

  it('normalizeHost lowercases and strips port + trailing dot', () => {
    expect(normalizeHost('AMELIA.EBDA.APP:443')).toBe('amelia.ebda.app');
    expect(normalizeHost('amelia.ebda.app.')).toBe('amelia.ebda.app');
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('[::1]:80')).toBeNull();
  });
});

describe('store origins', () => {
  it('storefrontOrigin is the custom domain, else <slug>.ebda.app — never a path on the apex', () => {
    expect(storefrontOrigin({ slug: 'amelia', domain: null })).toBe('https://amelia.ebda.app');
    expect(storefrontOrigin({ slug: 'amelia' })).toBe('https://amelia.ebda.app');
    expect(storefrontOrigin({ slug: 'amelia', domain: 'ameliaaurum.com' })).toBe(
      'https://ameliaaurum.com'
    );
    expect(storefrontOrigin({ slug: 'amelia', domain: ' AmeliaAurum.com ' })).toBe(
      'https://ameliaaurum.com'
    );
    expect(storefrontOrigin({ slug: 'amelia' })).not.toContain(`${BRAND.domains.marketing}/`);
    expect(storeOrigin('amelia')).toBe('https://amelia.ebda.app');
  });

  it('a parsed store host round-trips through storeOrigin', () => {
    const parsed = parseStoreHost('amelia.ebda.app');
    expect(parsed.kind).toBe('subdomain');
    if (parsed.kind === 'subdomain') {
      expect(parseStoreHost(new URL(storeOrigin(parsed.slug)).host)).toEqual(parsed);
    }
  });
});
