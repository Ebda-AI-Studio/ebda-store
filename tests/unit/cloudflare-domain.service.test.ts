import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/api/src/config', () => ({
  config: { cfApiToken: 'tok', cfZoneId: 'zone1', cfFallbackOrigin: 'cf.ebda.app' },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { CloudflareDomainService } from '../../apps/api/src/services/cloudflare-domain.service';

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CloudflareDomainService', () => {
  it('isConfigured requires token + zone + fallback origin', () => {
    expect(CloudflareDomainService.isConfigured()).toBe(true);
  });

  it('addDomain POSTs a custom hostname and returns the result', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockReturnValue(
        okJson({ success: true, result: { id: 'ch1', hostname: 'shop.x.com', status: 'pending' } })
      );
    const res = await CloudflareDomainService.addDomain('shop.x.com');
    expect(res).toMatchObject({ id: 'ch1', hostname: 'shop.x.com' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      hostname: 'shop.x.com',
      ssl: { method: 'http', type: 'dv' },
    });
  });

  it('getDomain maps active+ssl-active to verified with the CNAME instruction', async () => {
    vi.spyOn(global, 'fetch').mockReturnValue(
      okJson({
        success: true,
        result: [
          { id: 'ch1', hostname: 'shop.x.com', status: 'active', ssl: { status: 'active' } },
        ],
      })
    );
    const st = await CloudflareDomainService.getDomain('shop.x.com');
    expect(st).toEqual({
      domain: 'shop.x.com',
      verified: true,
      failed: false,
      misconfigured: false,
      dnsRecords: [{ type: 'CNAME', name: 'shop.x.com', value: 'cf.ebda.app' }],
    });
  });

  it.each([
    ['blocked hostname', { status: 'blocked', ssl: { status: 'pending_validation' } }],
    ['moved hostname', { status: 'moved', ssl: { status: 'pending_validation' } }],
    ['validation timed out', { status: 'pending', ssl: { status: 'validation_timed_out' } }],
    ['issuance timed out', { status: 'pending', ssl: { status: 'issuance_timed_out' } }],
  ])('getDomain reports a terminal provider state as failed: %s', async (_name, ch) => {
    vi.spyOn(global, 'fetch').mockReturnValue(
      okJson({ success: true, result: [{ id: 'ch1', hostname: 'shop.x.com', ...ch }] })
    );
    const st = await CloudflareDomainService.getDomain('shop.x.com');
    expect(st).toMatchObject({ verified: false, failed: true });
  });

  it('getDomain does NOT call a still-validating hostname failed', async () => {
    vi.spyOn(global, 'fetch').mockReturnValue(
      okJson({
        success: true,
        result: [
          {
            id: 'ch1',
            hostname: 'shop.x.com',
            status: 'pending',
            ssl: { status: 'pending_validation' },
          },
        ],
      })
    );
    const st = await CloudflareDomainService.getDomain('shop.x.com');
    expect(st).toMatchObject({ verified: false, failed: false });
  });

  it('getDomain reports not-verified while ssl is pending', async () => {
    vi.spyOn(global, 'fetch').mockReturnValue(
      okJson({
        success: true,
        result: [
          {
            id: 'ch1',
            hostname: 'shop.x.com',
            status: 'pending',
            ssl: { status: 'pending_validation' },
          },
        ],
      })
    );
    const st = await CloudflareDomainService.getDomain('shop.x.com');
    expect(st?.verified).toBe(false);
  });

  it('getDomain returns null when the hostname is unknown', async () => {
    vi.spyOn(global, 'fetch').mockReturnValue(okJson({ success: true, result: [] }));
    expect(await CloudflareDomainService.getDomain('nope.x.com')).toBeNull();
  });

  it('removeDomain looks up the id then DELETEs it', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockReturnValueOnce(
        okJson({
          success: true,
          result: [
            { id: 'ch1', hostname: 'shop.x.com', status: 'active', ssl: { status: 'active' } },
          ],
        })
      )
      .mockReturnValueOnce(okJson({ success: true, result: { id: 'ch1' } }));
    expect(await CloudflareDomainService.removeDomain('shop.x.com')).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames/ch1'
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });
});
