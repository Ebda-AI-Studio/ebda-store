/**
 * SSRF on the carrier clients.
 *
 * The original defect: a carrier took a merchant-supplied `baseUrl` credential and handed it
 * VERBATIM to `fetch()`, so a merchant admin could press "Test connection" with
 * `baseUrl = http://169.254.169.254/latest/meta-data` and read the cloud metadata endpoint back
 * through the error text. That carrier (iCarry) is gone (shipping batch, PROVIDERS-7), and the
 * class is closed at the root now:
 *
 *   1. NO carrier credential is a host. The catalog declares the fields; the connect route and
 *      `mergeCredentialFields` refuse any key the catalog does not list, so `baseUrl` cannot be
 *      stored (tests/unit/shipping-provider-connect.test.ts), and no adapter reads one.
 *   2. Every adapter resolves its host from code (sandbox / live constants) or an ENV override
 *      that is honoured only outside production: asserted below by driving each real adapter
 *      with an attacker host in every place a merchant could put one.
 *   3. The default transport (`safeFetch`) still resolves-and-blocks private ranges and
 *      re-validates every redirect hop (a public host 302ing to 169.254.169.254).
 *   4. A registry gate (bottom): a carrier source may not call `fetch`/`request`/`axios` bare.
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

import { carrierRequest } from '@api/lib/carrier-http';
import { CARRIER_REGISTRY } from '@api/services/carriers/registry';
import { CARRIER_CODES } from '@api/services/carriers/types';

function resolvesPublic() {
  lookup.mockResolvedValue([{ address: '93.184.216.34' }]);
}

const redirect = (location: string, status = 302) => ({
  status,
  ok: false,
  headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) },
  text: () => Promise.resolve(''),
});

describe('the default carrier transport re-validates every redirect hop', () => {
  const fetchSpy = vi.fn();
  const base = { url: 'https://attacker.example.com', stubbed: false };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a 302 from a public host to 169.254.169.254', async () => {
    lookup.mockImplementation((host: string) =>
      host === 'attacker.example.com'
        ? Promise.resolve([{ address: '93.184.216.34' }])
        : Promise.resolve([{ address: '169.254.169.254' }])
    );
    fetchSpy.mockResolvedValue(redirect('http://169.254.169.254/latest/meta-data'));
    await expect(carrierRequest('t', base, '/x', { method: 'GET' })).rejects.toThrow(
      /SSRF_BLOCKED/
    );
    // the first hop was made (that is how the redirect was learned); the SECOND never is
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('asks undici for manual redirects: the option is what makes the loop possible', async () => {
    resolvesPublic();
    fetchSpy.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: () => Promise.resolve('{}'),
    });
    await carrierRequest('t', base, '/x', { method: 'GET' }).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('refuses a redirect chain longer than the cap', async () => {
    resolvesPublic();
    fetchSpy.mockResolvedValue(redirect('https://attacker.example.com/next'));
    await expect(carrierRequest('t', base, '/x', { method: 'GET' })).rejects.toThrow(
      /SSRF_BLOCKED: too many redirects/
    );
  });

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data'],
    ['loopback', 'http://127.0.0.1:8080'],
    ['RFC1918', 'http://10.0.0.5/v1'],
    ['*.railway.internal', 'http://api.railway.internal'],
  ])('blocks a host that is %s before any request', async (_label, url) => {
    lookup.mockResolvedValue([
      { address: url.includes('169.254') ? '169.254.169.254' : '10.0.0.5' },
    ]);
    await expect(carrierRequest('t', { url, stubbed: false }, '/x', {})).rejects.toThrow(
      /SSRF_BLOCKED/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('no adapter takes a host from the merchant', () => {
  const fetchSpy = vi.fn();
  const ATTACKER = 'attacker.example.com';
  // every place a merchant could smuggle a host: a credential, a setting, a legacy key
  const hostile = {
    baseUrl: `https://${ATTACKER}`,
    url: `https://${ATTACKER}`,
    host: ATTACKER,
    endpoint: `https://${ATTACKER}`,
    apiKey: 'k',
    username: 'u',
    password: 'p',
    warehouseName: 'w',
    accountNumber: '123456',
    accountPin: '1',
    accountEntity: 'CAI',
    accountCountryCode: 'EG',
    webhookSecret: 'secret',
  };
  const ctx = {
    settings: {
      sandbox: false,
      baseUrl: `https://${ATTACKER}`,
      apiUrl: `https://${ATTACKER}`,
      host: ATTACKER,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockReset();
    resolvesPublic();
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve('{}'),
      })
    );
    vi.stubGlobal('fetch', fetchSpy);
    // the ENV override is the only legitimate seam and is ignored in production
    vi.stubEnv('NODE_ENV', 'production');
    for (const c of ['BOSTA', 'SHIPBLU', 'MYLERZ', 'ARAMEX']) vi.stubEnv(`${c}_BASE_URL`, '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const apiCarriers = CARRIER_CODES.filter(c => c !== 'manual');

  it.each(apiCarriers)(
    '%s: Test connection never sends a request to a merchant host',
    async code => {
      const adapter = CARRIER_REGISTRY[code];
      await adapter.testConnection(hostile, ctx).catch(() => undefined);
      for (const [url] of fetchSpy.mock.calls) {
        expect(new URL(String(url)).host, `${code} called ${String(url)}`).not.toBe(ATTACKER);
      }
      expect(
        fetchSpy.mock.calls.length,
        `${code} made no request at all: the probe proves nothing`
      ).toBeGreaterThan(0);
    }
  );

  it.each(apiCarriers)(
    '%s: track and cancel never send a request to a merchant host',
    async code => {
      const adapter = CARRIER_REGISTRY[code];
      await adapter.trackShipment(hostile, 'TRK1', ctx).catch(() => undefined);
      await Promise.resolve(adapter.cancelShipment(hostile, 'TRK1', ctx)).catch(() => undefined);
      for (const [url] of fetchSpy.mock.calls) {
        expect(new URL(String(url)).host, `${code} called ${String(url)}`).not.toBe(ATTACKER);
      }
    }
  );
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
    for (const f of ['bosta', 'shipblu', 'mylerz', 'aramex']) {
      expect(carrierFiles).toContain(`${f}.carrier.ts`);
    }
  });

  /**
   * Strips block comments, line comments and template/string literals before
   * scanning. Without this the gate matches its own prose: a docstring that
   * mentions "server-side `fetch()`" failed the first run of this
   * assertion on that comment rather than on any code — the same
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
