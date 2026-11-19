import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isGscConfigured, querySearchAnalytics, GscNoAccessError } from '../gsc-client';

// Throwaway RSA key generated at test runtime: no PEM is committed and it is
// NEVER a real Google service-account credential.
const DUMMY_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

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
