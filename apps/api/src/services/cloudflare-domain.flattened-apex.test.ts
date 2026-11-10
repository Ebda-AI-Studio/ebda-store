import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  config: { cfApiToken: 't', cfZoneId: 'z', cfFallbackOrigin: 'cf.ebda.app' },
}));
vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CloudflareDomainService, dnsPointsAtTarget } from './cloudflare-domain.service';

const TARGET_IPS = ['104.21.50.165', '172.67.207.118'];

/** DoH + CF API stub. `apexAnswers` = what a lookup of the merchant apex returns. */
function stubNetwork(opts: {
  apexAnswers: Array<{ type: number; data: string }>;
  cf: { status: string; ssl: string };
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'cloudflare-dns.com') {
        const name = u.searchParams.get('name');
        const type = u.searchParams.get('type');
        const answers =
          name === 'cf.ebda.app'
            ? type === 'A'
              ? TARGET_IPS.map(data => ({ type: 1, data }))
              : []
            : opts.apexAnswers.filter(a => (type === 'A' ? a.type !== 28 : a.type === 28));
        return { ok: true, json: async () => ({ Answer: answers }) };
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: [
            {
              id: 'h1',
              hostname: 'ameliaaurum.com',
              status: opts.cf.status,
              ssl: { status: opts.cf.ssl },
            },
          ],
        }),
      };
    })
  );
}

describe('flattened apex (QA-A11)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('A records equal to what cf.ebda.app resolves to count as pointing at us', async () => {
    stubNetwork({
      apexAnswers: TARGET_IPS.map(data => ({ type: 1, data })),
      cf: { status: 'pending', ssl: 'active' },
    });
    expect(await dnsPointsAtTarget('ameliaaurum.com', 'cf.ebda.app')).toBe(true);
  });

  it('a visible CNAME to the target still counts', async () => {
    stubNetwork({
      apexAnswers: [{ type: 5, data: 'cf.ebda.app.' }],
      cf: { status: 'pending', ssl: 'active' },
    });
    expect(await dnsPointsAtTarget('www.ameliaaurum.com', 'cf.ebda.app')).toBe(true);
  });

  it('unrelated A records (registrar parking) do not', async () => {
    stubNetwork({
      apexAnswers: [{ type: 1, data: '203.0.113.9' }],
      cf: { status: 'pending', ssl: 'active' },
    });
    expect(await dnsPointsAtTarget('ameliaaurum.com', 'cf.ebda.app')).toBe(false);
  });

  it('getDomain: hostname pending + SSL active + flattened apex => verified, not misconfigured', async () => {
    stubNetwork({
      apexAnswers: TARGET_IPS.map(data => ({ type: 1, data })),
      cf: { status: 'pending', ssl: 'active' },
    });
    const s = await CloudflareDomainService.getDomain('ameliaaurum.com');
    expect(s).toMatchObject({ verified: true, misconfigured: false });
  });

  it('getDomain: SSL active but DNS elsewhere stays unverified', async () => {
    stubNetwork({
      apexAnswers: [{ type: 1, data: '203.0.113.9' }],
      cf: { status: 'pending', ssl: 'active' },
    });
    const s = await CloudflareDomainService.getDomain('ameliaaurum.com');
    expect(s).toMatchObject({ verified: false, misconfigured: true });
  });

  it('getDomain: SSL not yet issued stays unverified even if DNS points at us', async () => {
    stubNetwork({
      apexAnswers: TARGET_IPS.map(data => ({ type: 1, data })),
      cf: { status: 'pending', ssl: 'pending_validation' },
    });
    const s = await CloudflareDomainService.getDomain('ameliaaurum.com');
    expect(s?.verified).toBe(false);
  });
});
