/**
 * SSRF on the iCarry carrier client.
 *
 * `shipping-carrier.routes.ts` validates a carrier's credentials as
 * `z.record(z.string(), z.string())` — any key, any string. `ICarryCredentials`
 * declares `baseUrl?: string  // allow override`, and `resolveBaseUrl` returned
 * that merchant-supplied string VERBATIM into four `fetch()` calls
 * (createShipment, trackShipment, cancelShipment, testConnection).
 *
 * So a merchant admin could set
 *   credentials.baseUrl = "http://169.254.169.254/latest/meta-data"
 * and press "Test connection". The API host fetches it and hands back
 * `HTTP <status>: <body.message>` — a status-code and partial-body oracle
 * against the Railway internal network and the cloud metadata endpoint.
 *
 * `lib/safe-fetch.ts` already had the guard. The ESLint rule that enforces it
 * was scoped to `routes/**` on the reasoning that a service taking a URL from
 * a route "is a review point". This is that review point, missed: the fetch
 * lives in `services/`, so the class was invisible to the only mechanism that
 * would have caught it.
 *
 * These tests pin BOTH halves — the blocklist, and that the carrier actually
 * routes through it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookup = vi.fn();
vi.mock('dns', () => ({
  promises: { lookup: (...a: unknown[]) => lookup(...a) },
  default: { promises: { lookup: (...a: unknown[]) => lookup(...a) } },
}));

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  resolveBaseUrl,
  ICARRY_BASE_URL,
  iCarryCarrier,
} from '@api/services/carriers/icarry.carrier';

/** Hosts that resolve to a public address, so only the URL itself is on trial. */
function resolvesPublic() {
  lookup.mockResolvedValue([{ address: '93.184.216.34' }]);
}

describe('resolveBaseUrl — merchant-supplied baseUrl is SSRF-validated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvesPublic();
  });

  it('returns the hardcoded default when the merchant sets no override', async () => {
    await expect(resolveBaseUrl({ apiKey: 'k' })).resolves.toBe(ICARRY_BASE_URL);
  });

  it('does not spend a DNS lookup validating our own constant', async () => {
    await resolveBaseUrl({ apiKey: 'k' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['cloud metadata (the prize)', 'http://169.254.169.254/latest/meta-data'],
    ['loopback', 'http://127.0.0.1:8080'],
    ['loopback, IPv6', 'http://[::1]:8080'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]'],
    ['RFC1918 10/8', 'http://10.0.0.5/v1'],
    ['RFC1918 172.16/12', 'http://172.16.31.9/v1'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/v1'],
    ['CGNAT 100.64/10', 'http://100.64.3.2/v1'],
    ['unspecified', 'http://0.0.0.0/v1'],
    ['link-local IPv6', 'http://[fe80::1]/v1'],
    ['unique-local IPv6', 'http://[fd00::1]/v1'],
  ])('blocks %s', async (_label, url) => {
    await expect(resolveBaseUrl({ apiKey: 'k', baseUrl: url })).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['gopher', 'gopher://127.0.0.1:11211/_stats'],
    ['data', 'data:text/plain,hi'],
  ])('blocks the %s scheme', async (_label, url) => {
    await expect(resolveBaseUrl({ apiKey: 'k', baseUrl: url })).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('blocks a malformed URL rather than string-concatenating it into a path', async () => {
    await expect(resolveBaseUrl({ apiKey: 'k', baseUrl: 'not a url' })).rejects.toThrow(
      /SSRF_BLOCKED/
    );
  });

  it('blocks *.railway.internal — the platform-internal name that does not resolve publicly', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      resolveBaseUrl({ apiKey: 'k', baseUrl: 'http://api.railway.internal' })
    ).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('blocks a public NAME that resolves to a private address (DNS-based bypass)', async () => {
    lookup.mockResolvedValue([{ address: '10.1.2.3' }]);
    await expect(
      resolveBaseUrl({ apiKey: 'k', baseUrl: 'https://evil.example.com' })
    ).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('blocks when ANY resolved address is private, not just the first', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34' }, { address: '127.0.0.1' }]);
    await expect(
      resolveBaseUrl({ apiKey: 'k', baseUrl: 'https://split-horizon.example.com' })
    ).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('accepts a genuine public override and strips the trailing slash', async () => {
    await expect(
      resolveBaseUrl({ apiKey: 'k', baseUrl: 'https://sandbox.icarry.com/v2/' })
    ).resolves.toBe('https://sandbox.icarry.com/v2');
  });
});

describe('every iCarry method routes its base URL through the guard', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    lookup.mockResolvedValue([{ address: '169.254.169.254' }]);
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const BAD = { apiKey: 'k', baseUrl: 'http://169.254.169.254' };

  it('createShipment refuses and never calls fetch', async () => {
    await expect(
      iCarryCarrier.createShipment(BAD, {
        orderId: 'o1',
        orderNumber: 'ORD-1',
        pickupAddress: {} as never,
        deliveryAddress: {} as never,
        items: [],
      } as never)
    ).rejects.toThrow(/SSRF_BLOCKED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('trackShipment refuses and never calls fetch', async () => {
    await expect(iCarryCarrier.trackShipment(BAD, 'TRACK-1')).rejects.toThrow(/SSRF_BLOCKED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancelShipment refuses and never calls fetch', async () => {
    await expect(iCarryCarrier.cancelShipment(BAD, 'SHIP-1')).rejects.toThrow(/SSRF_BLOCKED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testConnection — the reachable one — returns a failure instead of probing', async () => {
    const result = await iCarryCarrier.testConnection(BAD);
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The merchant gets the VERDICT, never the reason: `assertPublicHttpUrl`
    // distinguishes "does not resolve" from "resolves to a private address",
    // and surfacing that turns this endpoint into a boolean oracle over the
    // API host's resolver. The detailed reason stays in the log line.
    expect(result.error).toBe('Base URL must be a public http(s) address.');
    expect(result.error).not.toMatch(/SSRF_BLOCKED|resolve|private/i);
  });
});

describe('redirects are re-validated — a pre-flight check alone is not a guard', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The attacker controls a GENUINELY PUBLIC host, so the pre-flight
   * `assertPublicHttpUrl` on the base URL passes — and then the host 302s to
   * the cloud metadata endpoint. `fetch` defaults to `redirect: 'follow'`, so
   * before `safeFetch` this walked straight through the new guard.
   */
  it('refuses a 302 from a public host to 169.254.169.254', async () => {
    lookup.mockImplementation((host: string) =>
      host === 'attacker.example.com'
        ? Promise.resolve([{ address: '93.184.216.34' }])
        : Promise.resolve([{ address: '169.254.169.254' }])
    );
    fetchSpy.mockResolvedValue({
      status: 302,
      headers: {
        get: (h: string) => (h === 'location' ? 'http://169.254.169.254/latest/meta-data' : null),
      },
    });

    await expect(
      iCarryCarrier.trackShipment({ apiKey: 'k', baseUrl: 'https://attacker.example.com' }, 'T1')
    ).rejects.toThrow(/SSRF_BLOCKED/);

    // The first hop was made (that is how we learned about the redirect);
    // the SECOND must never be.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('asks undici for manual redirects — the option is what makes the loop possible', async () => {
    resolvesPublic();
    fetchSpy.mockResolvedValue({ status: 200, json: () => Promise.resolve({}), ok: true });
    await iCarryCarrier
      .testConnection({ apiKey: 'k', baseUrl: 'https://sandbox.icarry.com' })
      .catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('refuses a redirect chain longer than the cap', async () => {
    resolvesPublic();
    fetchSpy.mockResolvedValue({
      status: 302,
      headers: { get: () => 'https://public.example.com/next' },
    });
    await expect(
      iCarryCarrier.trackShipment({ apiKey: 'k', baseUrl: 'https://public.example.com' }, 'T1')
    ).rejects.toThrow(/SSRF_BLOCKED: too many redirects/);
  });
});

/**
 * The half a pre-flight assert cannot cover.
 *
 * `assertPublicHttpUrl` only ever sees the FIRST URL. A merchant who owns a
 * public host passes it trivially and then answers the request with
 * `302 Location: http://169.254.169.254/…`; bare `fetch()` defaults to
 * `redirect: 'follow'`, so undici walks there and `testConnection` reports the
 * status and `body.message` back — the same oracle, one hop later. The fix is
 * the transport (`safeFetch`), not the assert, and these are the tests that
 * tell the difference: every URL fed in here is PUBLIC.
 */
describe('a public baseUrl that redirects to a private address', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset, not clearAllMocks: an undrained mockResolvedValueOnce queue
    // survives a clear and feeds the next test's first call — the exact
    // state-pollution the retry-0 unit gate exists to expose.
    fetchSpy.mockReset();
    resolvesPublic(); // every NAME resolves public — only the hop is on trial
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const SNEAKY = { apiKey: 'k', baseUrl: 'https://redirector.example.com' };
  const METADATA = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';

  function redirect(location: string, status = 302) {
    return {
      status,
      ok: false,
      statusText: 'Found',
      headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
      json: async () => ({}),
    };
  }
  function ok(body: unknown = {}) {
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => body,
    };
  }
  /** The metadata endpoint was never contacted, whatever the call returned. */
  function neverReachedMetadata() {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://redirector.example.com/merchants/me');
  }

  it('testConnection — the reachable one — refuses the hop instead of reporting it', async () => {
    fetchSpy.mockResolvedValue(redirect(METADATA));

    const result = await iCarryCarrier.testConnection(SNEAKY);

    expect(result.success).toBe(false);
    neverReachedMetadata();
    // The merchant is told the VERDICT, never which check fired.
    // `assertPublicHttpUrl` distinguishes "does not resolve" from "resolves to
    // a private address", and surfacing that turns this endpoint into a
    // boolean oracle over the API host's resolver. The reason stays in the log.
    expect(result.error).toBe('Base URL must be a public http(s) address.');
    expect(result.error).not.toMatch(/SSRF_BLOCKED|resolve|private|169\.254/i);
  });

  const SHIPMENT = {
    orderId: 'o1',
    orderNumber: 'ORD-1',
    pickupAddress: {} as never,
    deliveryAddress: {} as never,
    items: [],
  } as never;

  /** Exactly one request went out, and it went to the merchant's own host. */
  function stoppedAtTheFirstHop() {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^https:\/\/redirector\.example\.com\//);
  }

  it('createShipment refuses the hop', async () => {
    fetchSpy.mockResolvedValue(redirect(METADATA));
    await expect(iCarryCarrier.createShipment(SNEAKY, SHIPMENT)).rejects.toThrow(/SSRF_BLOCKED/);
    stoppedAtTheFirstHop();
  });

  it('trackShipment refuses the hop', async () => {
    fetchSpy.mockResolvedValue(redirect(METADATA));
    await expect(iCarryCarrier.trackShipment(SNEAKY, 'TRACK-1')).rejects.toThrow(/SSRF_BLOCKED/);
    stoppedAtTheFirstHop();
  });

  it('cancelShipment refuses the hop (its contract is false, not a throw)', async () => {
    fetchSpy.mockResolvedValue(redirect(METADATA));
    await expect(iCarryCarrier.cancelShipment(SNEAKY, 'SHIP-1')).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect chain that only turns private on the second hop', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://hop-two.example.com/next'))
      .mockResolvedValueOnce(redirect('http://127.0.0.1:6379/'));

    const result = await iCarryCarrier.testConnection(SNEAKY);

    expect(result.success).toBe(false);
    // Generic message, same as every other blocked case — see the oracle note
    // on the testConnection test above.
    expect(result.error).toBe('Base URL must be a public http(s) address.');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // hop 3 never went out
  });

  it('still follows a legitimate public redirect — the guard is not a blanket ban', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://api2.icarry.com/merchants/me'))
      .mockResolvedValueOnce(ok());

    await expect(iCarryCarrier.testConnection(SNEAKY)).resolves.toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not hand the merchant API key to a host the redirect chose', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://collector.example.com/merchants/me'))
      .mockResolvedValueOnce(ok());

    await iCarryCarrier.testConnection(SNEAKY);

    const firstHop = new Headers(fetchSpy.mock.calls[0][1].headers);
    const secondHop = new Headers(fetchSpy.mock.calls[1][1].headers);
    expect(firstHop.get('authorization')).toBe('Bearer k');
    expect(secondHop.get('authorization')).toBeNull();
  });

  it('keeps the API key on a same-origin redirect', async () => {
    fetchSpy.mockResolvedValueOnce(redirect('/v2/merchants/me')).mockResolvedValueOnce(ok());

    await iCarryCarrier.testConnection(SNEAKY);

    expect(String(fetchSpy.mock.calls[1][0])).toBe(
      'https://redirector.example.com/v2/merchants/me'
    );
    expect(new Headers(fetchSpy.mock.calls[1][1].headers).get('authorization')).toBe('Bearer k');
  });

  it('does not re-POST the shipment payload to a redirect target', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://collector.example.com/orders'))
      .mockResolvedValueOnce(ok({ id: 'x', tracking_number: 't' }));

    await iCarryCarrier.createShipment(SNEAKY, SHIPMENT);

    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    expect(fetchSpy.mock.calls[1][1].method).toBe('GET');
    expect(fetchSpy.mock.calls[1][1].body).toBeUndefined();
  });
});

/**
 * Registry gate: a NEW carrier must not reintroduce the class.
 *
 * The plan's remedy was to widen the ESLint SSRF selector from `routes/**` to
 * `services/**`. Measured, that produces 36 errors across 17 files — and all
 * but iCarry's are a URL built from `process.env` / a module constant:
 *
 *   - all four payment providers set `baseUrl` from a hardcoded constant
 *     chosen by `isTestMode` (verified 2026-09-11), so the money path was
 *     never exposed;
 *   - aramex uses a module-level `ARAMEX_BASE_URL`;
 *   - onesignal / wbs-bridge / sms / gsc / cloudflare-domain build from config.
 *
 * A 17-file allowlist is the rule the original scoping note predicted people
 * would learn to silence, and an `eslint-disable` comment silences it for
 * free. This gate cannot be disabled that way: it reads the carrier sources
 * and fails if one calls `fetch()` without importing the SSRF guard.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const CARRIER_DIR = join(__dirname, '../../apps/api/src/services/carriers');

/**
 * Every `.ts` source under `services/carriers/`, recursively — a future
 * vendor subdirectory (e.g. `carriers/vendor-x/client.ts`) must not be
 * invisible to this gate just because `readdirSync` used to be non-recursive
 * and no subdirectory existed yet to expose that.
 */
function listCarrierFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = entry.name;
    if (entry.isDirectory()) {
      out.push(...listCarrierFiles(join(dir, rel)).map(f => join(rel, f)));
    } else if (rel.endsWith('.ts') && !rel.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Any credentials field whose NAME suggests it carries a URL. The write-side
 * schema is `z.record(z.string(), z.string())` (shipping-carrier.routes.ts),
 * so a carrier may name its endpoint field anything — `apiUrl`, `endpoint`,
 * `host`, `gatewayUrl`. Keying the gate on the literal string `baseUrl` would
 * have let the next carrier past it by renaming one field.
 */
const URL_FIELD = /\b\w*(url|uri|endpoint|host|base)\w*\??\s*:\s*string/i;

describe('carrier registry — every fetching carrier routes through the guard', () => {
  // `types.ts` is scanned too: several provider families declare their
  // credentials interface in a sibling types file, which would leave the
  // carrier's own source with no URL field to match and skip it silently.
  const carrierFiles = listCarrierFiles(CARRIER_DIR);

  it('finds the carrier sources (guards against an empty-set pass)', () => {
    expect(carrierFiles.length).toBeGreaterThanOrEqual(2);
    expect(carrierFiles).toContain('icarry.carrier.ts');
  });

  /**
   * Strips block comments, line comments and template/string literals before
   * scanning. Without this the gate matches its own prose: icarry's docstring
   * contains the words "server-side `fetch()`", and the first run of this
   * assertion failed on that comment rather than on any code — the same
   * comment-matching defect already filed as issue #1678 against another gate.
   */
  const stripNonCode = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  /**
   * Other ways to make an outbound HTTP request that a carrier could reach
   * for instead of bare `fetch(` — undici's low-level `request()`, Node's
   * `http(s).request()`, and axios. Qualified forms (`https.request(`,
   * `undici.request(`, `axios.get(`, …) are unambiguous by shape. A BARE
   * call (`request(...)`, `axios(...)`) only counts when the file itself
   * imported that name from one of those modules — `request` alone is too
   * common an identifier to flag unconditionally.
   */
  function outboundCallSites(src: string): RegExpMatchArray[] {
    const sites: RegExpMatchArray[] = [
      ...src.matchAll(
        /\b(?:https?|undici)\.request\(|\baxios\.(?:request|get|post|put|patch|delete)\(/g
      ),
    ];

    const namedImports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]undici['"]/g)].flatMap(
      m =>
        m[1].split(',').map(
          s =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop()
              ?.trim() ?? ''
        )
    );
    const defaultImports = [
      ...src.matchAll(/import\s+(\w+)\s*(?:,[^;]*)?from\s*['"](?:undici|axios)['"]/g),
    ].map(m => m[1]);

    for (const name of [...namedImports, ...defaultImports].filter(Boolean)) {
      sites.push(...src.matchAll(new RegExp(`(?<![.\\w])${name}\\(`, 'g')));
    }
    return sites;
  }

  it.each(carrierFiles)('%s has no bare fetch/request/axios call', file => {
    const src = stripNonCode(readFileSync(join(CARRIER_DIR, file), 'utf8'));

    // Asserting on CALL SITES, not on import presence. An unused import — or
    // one used on three of four fetch paths — satisfies "does it import the
    // guard" while leaving the class open. That is the same "defence present
    // but not on the path" shape the sibling reject-impersonated test exists
    // to catch, and the audit found it here first.
    const bareFetch = src.includes('fetch(')
      ? [...src.matchAll(/(?<![a-zA-Z])fetch\(/g)].filter((m: any) => {
          const before = src.slice(Math.max(0, m.index - 12), m.index);
          return !/safeFetch|safeFetchImage/.test(before);
        })
      : [];
    const bareOther = outboundCallSites(src);
    const bare = [...bareFetch, ...bareOther];
    if (bare.length === 0) return; // a non-fetching file is fine

    expect(
      bare.length,
      `${file} makes ${bare.length} direct outbound HTTP call(s) (fetch/request/axios). ` +
        `Merchant-influenced URLs must go through safeFetch from lib/safe-fetch — a ` +
        `pre-flight assertPublicHttpUrl does not stop a 302 to 169.254.169.254.`
    ).toBe(0);
  });

  it.each(carrierFiles)(
    '%s: a URL credential + an outbound call means THIS file imports the redirect-safe helper',
    file => {
      const src = readFileSync(join(CARRIER_DIR, file), 'utf8');
      const stripped = stripNonCode(src);
      const declaresUrlField = URL_FIELD.test(src);
      const makesOutboundCall =
        stripped.includes('fetch(') || outboundCallSites(stripped).length > 0;
      if (!declaresUrlField || !makesOutboundCall) return;

      // Per-file, not per-directory: a sibling file importing safeFetch does
      // not prove THIS file's merchant-influenced URL is guarded — the same
      // "defence present somewhere, not on the path" gap the bare-call check
      // above exists to catch.
      expect(
        /safeFetch\b/.test(src),
        `${file} declares a URL-shaped credential field and makes an outbound call, ` +
          `but does not import safeFetch itself`
      ).toBe(true);
    }
  );
});
