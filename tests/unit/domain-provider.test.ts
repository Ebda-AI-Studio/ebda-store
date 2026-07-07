import { describe, it, expect } from 'vitest';

import {
  resolveDomainService,
  getDomainProviderName,
} from '../../apps/api/src/services/domain-provider';
import { CloudflareDomainService } from '../../apps/api/src/services/cloudflare-domain.service';

describe('resolveDomainService', () => {
  it('always resolves to Cloudflare (the sole provider since Vercel was cancelled)', () => {
    expect(resolveDomainService(null)).toBe(CloudflareDomainService);
    expect(resolveDomainService({ domainProvider: null })).toBe(CloudflareDomainService);
    expect(getDomainProviderName({ domainProvider: null })).toBe('cloudflare');
  });

  it('ignores a per-store override value — there is nothing else to select', () => {
    expect(resolveDomainService({ domainProvider: 'cloudflare' })).toBe(CloudflareDomainService);
    expect(resolveDomainService({ domainProvider: 'bogus' as never })).toBe(
      CloudflareDomainService
    );
  });
});
