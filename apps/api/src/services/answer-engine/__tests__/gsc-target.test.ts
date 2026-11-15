import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  pickGscTarget,
  resolveGscTarget,
  listAccessibleGscSites,
  resetGscSitesCache,
  querySearchAnalytics,
} from '../gsc-client';

const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
// nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account -- throwaway fixture key
const SA = JSON.stringify({ client_email: 'x@dummy.iam.gserviceaccount.com', private_key: KEY });

describe('pickGscTarget', () => {
  it('a <slug>.ebda.app store resolves to the parent sc-domain property with its host as the page filter', () => {
    expect(pickGscTarget('shop.ebda.app', ['sc-domain:ebda.app'])).toEqual({
      siteUrl: 'sc-domain:ebda.app',
      pageHost: 'shop.ebda.app',
    });
  });

  it('a sibling-prefix host never leaks: ab.ebda.app does not match a b.ebda.app property', () => {
    expect(pickGscTarget('ab.ebda.app', ['sc-domain:b.ebda.app'])).toBeNull();
    expect(pickGscTarget('notebda.app', ['sc-domain:ebda.app'])).toBeNull();
  });

  it('an exact property is preferred over the parent and needs no page filter', () => {
    expect(
      pickGscTarget('shop.ebda.app', ['sc-domain:ebda.app', 'sc-domain:shop.ebda.app'])
    ).toEqual({ siteUrl: 'sc-domain:shop.ebda.app' });
    expect(
      pickGscTarget('shop.ebda.app', ['sc-domain:ebda.app', 'https://shop.ebda.app/'])
    ).toEqual({ siteUrl: 'https://shop.ebda.app/' });
  });

  it('the most specific parent wins', () => {
    expect(pickGscTarget('a.b.ebda.app', ['sc-domain:ebda.app', 'sc-domain:b.ebda.app'])).toEqual({
      siteUrl: 'sc-domain:b.ebda.app',
      pageHost: 'a.b.ebda.app',
    });
  });

  it('an unknown host returns null instead of throwing', () => {
    expect(pickGscTarget('ameliaaurum.com', ['sc-domain:ebda.app'])).toBeNull();
    expect(pickGscTarget('', ['sc-domain:ebda.app'])).toBeNull();
    expect(pickGscTarget('x.ebda.app', [])).toBeNull();
  });
});

describe('sites.list + page filter', () => {
  const originalEnv = process.env.GSC_SERVICE_ACCOUNT_JSON;
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.GSC_SERVICE_ACCOUNT_JSON = SA;
    resetGscSitesCache();
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GSC_SERVICE_ACCOUNT_JSON;
    else process.env.GSC_SERVICE_ACCOUNT_JSON = originalEnv;
    global.fetch = originalFetch;
  });

  const token = { ok: true, status: 200, json: async () => ({ access_token: 't' }) };

  it('lists once per window (cached), drops unverified properties, and resolves', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          siteEntry: [
            { siteUrl: 'sc-domain:ebda.app', permissionLevel: 'siteFullUser' },
            { siteUrl: 'sc-domain:nope.com', permissionLevel: 'siteUnverifiedUser' },
          ],
        }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await resolveGscTarget('a.ebda.app')).toEqual({
      siteUrl: 'sc-domain:ebda.app',
      pageHost: 'a.ebda.app',
    });
    expect(await resolveGscTarget('b.ebda.app')).not.toBeNull();
    expect(await resolveGscTarget('x.nope.com')).toBeNull();
    expect(await listAccessibleGscSites()).toEqual(['sc-domain:ebda.app']);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 token + 1 sites.list for all four lookups
  });

  it('a parent-property query sends a scheme-anchored page filter on both calls', async () => {
    const rows = { ok: true, status: 200, json: async () => ({ rows: [] }) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows);
    global.fetch = fetchMock as unknown as typeof fetch;

    await querySearchAnalytics('sc-domain:ebda.app', '2026-11-01', '2026-11-01', {
      pageHost: 'b.ebda.app',
    });
    for (const call of fetchMock.mock.calls.slice(1) as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(call[1].body)).dimensionFilterGroups).toEqual([
        {
          groupType: 'and',
          filters: [{ dimension: 'page', operator: 'contains', expression: 'https://b.ebda.app/' }],
        },
      ]);
    }
  });

  it('an exact-property query sends no filter', async () => {
    const rows = { ok: true, status: 200, json: async () => ({ rows: [] }) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows);
    global.fetch = fetchMock as unknown as typeof fetch;
    await querySearchAnalytics('sc-domain:ebda.app', '2026-11-01', '2026-11-01');
    const body = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.dimensionFilterGroups).toBeUndefined();
  });
});
