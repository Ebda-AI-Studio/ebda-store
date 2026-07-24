import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isGscConfigured,
  gscSiteUrlsForDomain,
  querySearchAnalytics,
  GscNoAccessError,
} from '../gsc-client';

// Throwaway RSA key generated solely for this test suite — NEVER a real
// Google service-account credential. Regenerate with:
//   node -e "const c=require('crypto');const {privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});console.log(JSON.stringify(privateKey))"
const DUMMY_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCdxE5/1ApPeous\n' +
  'HfnbTKSun0beSeO/53TeFRruO81iykxslbJ2AFz78u1y/4UCKh0fJn6kHCE5CKa4\n' +
  'rNk2IfwEWd+k0lhyfvq2c40Cv0EDeu4QLug783yYK/jx9aeOM2gXCRSFoLQkgnuE\n' +
  '7p38fgFlciW3S9glBkZ4bUIdwt6N3VAJJQbaGIB1Kd3ZGqM82gz4oUqO3H7ElYUA\n' +
  'RfooyMKUVSL71VLfbEnY5bhNUV3IPH81ZHkHMgRxyZqWUVN7z4YQwWMFieBzLw1A\n' +
  'J8LLKbuIBOG8aOBhgTSFs/0QoLLyK1+APD/1UqRL6+6dRo6gspAEtQT/bVnuWw0h\n' +
  'XRQQCLF3AgMBAAECggEADx3z8PcDXzw8d+s4uWpYTqHVFjr5nLYekk0ZaIHIcKfh\n' +
  'DM0x7XFOzOwpE8onbN6rgwRFluSvIO+S8hfLNGRV6Ut8oibER4Gin6rmHxZDsi6s\n' +
  'SFaw9VWjtv0M/I+aVNuDeiQ/mCee5e9ZdeewsbSX3lLtXuk14SOpyvjvyzmUk6kz\n' +
  'nDjm07wI9wchYGBdTM7cFDagEuV6dm7xXAFfY5mkviqnPNWmjWChxTLTYs14cL0y\n' +
  '1RSMjkwLS6TWBQ1WJ83UUrqaDa7inrzE24uf9SEDeBrjPr5smZUwVEmJtAmwq+n8\n' +
  'ItsSC+X8UKLL5pB6IGJ0EOrC6PNjAEw0qq5iAWE3OQKBgQDLXPIKzsYNK2RR+RoZ\n' +
  'IJiqW+2FMNILQlw4RRBy41fK/g6MVq5aQQnrJmCL/DF+7XQzruD5vPnDTKeoWP6j\n' +
  'qtZg+OV5C0bMvCAIpdVb91XYf1GjKajGBqhr9c6jS/Izq72HXt7xlpNqeCtXAQ+Q\n' +
  'wBPhe2zXJUVJJlDV8ncDU8clLQKBgQDGmhrqrc8xyZWWqE/iYFsq9n7mEWeMGC/u\n' +
  'kBNSpI/QOlhARKmZMl9qRLK56gE0R3CYuc8+HE5I9S+TcstK9EqM5xd/DI4aKHEM\n' +
  '/OccZdq9COcuJVHGWTKVABBDuxzWNJZdNlZTUVVfr/7cjw8bhTKeXTF3M+0CrOv3\n' +
  '4KAAI7ZfswKBgQC02PYiaFm2EnWHdHgiClvZfCDQxma0PpJWNAz5rnU/fwkfAmLQ\n' +
  'vm/8n0dSlbbKgo5I++b0EHsok72xN1tT3zQATrd7Gm0e2tm99wOzYlQEUM0fxYdi\n' +
  'ez9BqvnVPE+qZbsJbHPk8hwsnaslFztpZXcImUNkXK+t6pYOfS4bVmCODQKBgQCl\n' +
  'ehXfYD75TuuTAl69UmfkHkqRzAKpGiYl8moHPBKP/20074EYon4Z/2+jtLSYKMZK\n' +
  'mtdw+wjHhXPEuatlorLTQGG1fHKSnQvFNJwkb0GYrGhjbLj8OaoJuGnU5X0bhemb\n' +
  'dQDsnyIxfmUuxQxjc9I/XYsvtVZQGmDqwoDOXPNCPQKBgH6obOBiUXgg3MoH87nv\n' +
  'MbjSqfgFDTC65/Zfst8xVKoTECTO/suCivDWm+Aktlz2+ZHXmaWq1FYcM9qiymy1\n' +
  'XymzvZWoFPjMq4v5/A1/Zz726KprvTuV2iDfyq5n0nfLHN2GUXCAbG7qZ4eLfSAN\n' +
  'ZxRpMf4ygB73H96B5qxMMR3/\n' +
  '-----END PRIVATE KEY-----\n';

const DUMMY_SERVICE_ACCOUNT_JSON = JSON.stringify({
  // nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account -- fake test fixture (dummy-project + throwaway key), not a real credential
  type: 'service_account',
  client_email: 'gsc-reader@dummy-project.iam.gserviceaccount.com',
  private_key: DUMMY_PRIVATE_KEY,
});

describe('gsc-client', () => {
  const originalEnv = process.env.GSC_SERVICE_ACCOUNT_JSON;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GSC_SERVICE_ACCOUNT_JSON;
    } else {
      process.env.GSC_SERVICE_ACCOUNT_JSON = originalEnv;
    }
    global.fetch = originalFetch;
  });

  describe('isGscConfigured', () => {
    it('is false when the env var is unset', () => {
      delete process.env.GSC_SERVICE_ACCOUNT_JSON;
      expect(isGscConfigured()).toBe(false);
    });

    it('is false when the env var is garbage (not JSON)', () => {
      process.env.GSC_SERVICE_ACCOUNT_JSON = 'not-json-at-all{{{';
      expect(isGscConfigured()).toBe(false);
    });

    it('is false when JSON is valid but missing client_email/private_key', () => {
      // nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account -- negative-case fixture, no real secret
      process.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account' });
      expect(isGscConfigured()).toBe(false);
    });

    it('is true with a valid service-account JSON (client_email + private_key present)', () => {
      process.env.GSC_SERVICE_ACCOUNT_JSON = DUMMY_SERVICE_ACCOUNT_JSON;
      expect(isGscConfigured()).toBe(true);
    });
  });

  describe('gscSiteUrlsForDomain', () => {
    it('normalizes (lowercase, strip leading www.) and returns both property forms', () => {
      expect(gscSiteUrlsForDomain('www.Foo.com')).toEqual([
        'sc-domain:foo.com',
        'https://foo.com/',
      ]);
    });

    it('handles a domain with no www. prefix', () => {
      expect(gscSiteUrlsForDomain('Bar.co')).toEqual(['sc-domain:bar.co', 'https://bar.co/']);
    });
  });

  describe('querySearchAnalytics', () => {
    function mockTokenThenResponses(
      responses: Array<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>
    ) {
      const tokenResponse = {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'test-access-token', expires_in: 3599 }),
      };
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(tokenResponse);
      for (const r of responses) {
        mockFetch.mockResolvedValueOnce(r);
      }
      global.fetch = mockFetch as unknown as typeof fetch;
      return mockFetch;
    }

    it('mints a Bearer token from the service account and maps a canned rows[] response into GscResult', async () => {
      process.env.GSC_SERVICE_ACCOUNT_JSON = DUMMY_SERVICE_ACCOUNT_JSON;

      const dateResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          rows: [
            { keys: ['2026-07-01'], clicks: 3, impressions: 100, ctr: 0.03, position: 8.2 },
            { keys: ['2026-07-02'], clicks: 5, impressions: 120, ctr: 0.0417, position: 7.9 },
          ],
        }),
      };
      const queryResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          rows: [
            { keys: ['best widgets'], clicks: 4, impressions: 80, ctr: 0.05, position: 3.1 },
            { keys: ['widget repair'], clicks: 1, impressions: 40, ctr: 0.025, position: 9.4 },
          ],
        }),
      };

      const mockFetch = mockTokenThenResponses([dateResponse, queryResponse]);

      const result = await querySearchAnalytics('sc-domain:foo.com', '2026-07-01', '2026-07-02');

      expect(result.dateRows).toEqual([
        { date: '2026-07-01', impressions: 100, clicks: 3, ctr: 0.03, position: 8.2 },
        { date: '2026-07-02', impressions: 120, clicks: 5, ctr: 0.0417, position: 7.9 },
      ]);
      expect(result.topQueries).toEqual([
        { query: 'best widgets', impressions: 80, clicks: 4 },
        { query: 'widget repair', impressions: 40, clicks: 1 },
      ]);

      // Call 0 = token mint.
      const [tokenUrl, tokenInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
      expect(String(tokenInit.body)).toContain(
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer'
      );
      expect(String(tokenInit.body)).toContain('assertion=');

      // Calls 1+2 = Search Analytics queries, Bearer + correct encoded site URL.
      const restCalls = mockFetch.mock.calls.slice(1) as Array<
        [string, RequestInit & { headers: Record<string, string> }]
      >;
      expect(restCalls).toHaveLength(2);
      for (const [url, init] of restCalls) {
        expect(url).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Afoo.com/searchAnalytics/query'
        );
        expect(init.headers.Authorization).toBe('Bearer test-access-token');
      }
      const bodies = restCalls.map(([, init]) => JSON.parse(init.body as string));
      expect(bodies.some(b => Array.isArray(b.dimensions) && b.dimensions[0] === 'date')).toBe(
        true
      );
      const queryCallBody = bodies.find(
        b => Array.isArray(b.dimensions) && b.dimensions[0] === 'query'
      );
      expect(queryCallBody.rowLimit).toBeLessThanOrEqual(10);
    });

    it('throws GscNoAccessError when the Search Analytics call 403s (service account lacks property access)', async () => {
      process.env.GSC_SERVICE_ACCOUNT_JSON = DUMMY_SERVICE_ACCOUNT_JSON;

      mockTokenThenResponses([
        { ok: false, status: 403, json: async () => ({ error: { code: 403 } }) },
        { ok: false, status: 403, json: async () => ({ error: { code: 403 } }) },
      ]);

      await expect(
        querySearchAnalytics('https://foo.com/', '2026-07-01', '2026-07-02')
      ).rejects.toBeInstanceOf(GscNoAccessError);
    });

    it('returns a safe empty GscResult (never throws) on a malformed/empty response body', async () => {
      process.env.GSC_SERVICE_ACCOUNT_JSON = DUMMY_SERVICE_ACCOUNT_JSON;

      mockTokenThenResponses([
        { ok: true, status: 200, json: async () => ({}) },
        { ok: true, status: 200, json: async () => ({ rows: 'not-an-array' }) },
      ]);

      const result = await querySearchAnalytics('sc-domain:foo.com', '2026-07-01', '2026-07-02');
      expect(result).toEqual({ dateRows: [], topQueries: [] });
    });

    it('returns a safe empty GscResult when a response body is missing rows entirely', async () => {
      process.env.GSC_SERVICE_ACCOUNT_JSON = DUMMY_SERVICE_ACCOUNT_JSON;

      mockTokenThenResponses([
        { ok: true, status: 200, json: async () => null },
        { ok: true, status: 200, json: async () => undefined },
      ]);

      const result = await querySearchAnalytics('sc-domain:foo.com', '2026-07-01', '2026-07-02');
      expect(result).toEqual({ dateRows: [], topQueries: [] });
    });

    it('rejects if called while GSC is not configured (defense in depth; cron must guard on isGscConfigured)', async () => {
      delete process.env.GSC_SERVICE_ACCOUNT_JSON;
      await expect(
        querySearchAnalytics('sc-domain:foo.com', '2026-07-01', '2026-07-02')
      ).rejects.toThrow();
    });
  });
});
