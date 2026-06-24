import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/api/src/config', () => ({
  config: {
    domainProvider: 'vercel',
    vercelApiToken: 'vt',
    vercelProjectId: 'vp',
    vercelTeamId: '',
    cfApiToken: 'ct',
    cfZoneId: 'cz',
    cfFallbackOrigin: 'cf.example.com',
  },
}));

import {
  resolveDomainService,
  getDomainProviderName,
} from '../../apps/api/src/services/domain-provider';
import { VercelDomainService } from '../../apps/api/src/services/vercel-domain.service';
import { CloudflareDomainService } from '../../apps/api/src/services/cloudflare-domain.service';

describe('resolveDomainService', () => {
  it('defaults to Vercel when the store has no override and env default is vercel', () => {
    expect(resolveDomainService(null)).toBe(VercelDomainService);
    expect(resolveDomainService({ domainProvider: null })).toBe(VercelDomainService);
    expect(getDomainProviderName({ domainProvider: null })).toBe('vercel');
  });

  it('uses the per-store override when set', () => {
    expect(resolveDomainService({ domainProvider: 'cloudflare' })).toBe(CloudflareDomainService);
    expect(getDomainProviderName({ domainProvider: 'cloudflare' })).toBe('cloudflare');
  });

  it('ignores an invalid per-store value and falls back to the env default', () => {
    expect(resolveDomainService({ domainProvider: 'bogus' as never })).toBe(VercelDomainService);
  });
});
