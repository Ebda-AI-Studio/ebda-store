import { config } from '../config';
import { VercelDomainService } from './vercel-domain.service';
import { CloudflareDomainService } from './cloudflare-domain.service';

/** Canonical DNS row a merchant must create. */
export interface DomainDnsRecord {
  type: string;
  name: string;
  value: string;
}

/** Provider-agnostic status returned to the admin domain page. */
export interface DomainStatus {
  domain: string;
  verified: boolean;
  misconfigured: boolean;
  dnsRecords: DomainDnsRecord[];
}

/** The contract both VercelDomainService and CloudflareDomainService satisfy. */
export interface DomainProvider {
  readonly providerName: 'vercel' | 'cloudflare';
  isConfigured(): boolean;
  /** Attach a custom domain. Returns true-ish on success, null when not configured. */
  addDomain(domain: string): Promise<unknown | null>;
  /** Detach a custom domain (rollback / removal). */
  removeDomain(domain: string): Promise<boolean>;
  /** Current verification + DNS instructions, or null when not configured / not found. */
  getDomain(domain: string): Promise<DomainStatus | null>;
}

const PROVIDERS: Record<'vercel' | 'cloudflare', DomainProvider> = {
  vercel: VercelDomainService,
  cloudflare: CloudflareDomainService,
};

function normalize(p: string | null | undefined): 'vercel' | 'cloudflare' | null {
  return p === 'cloudflare' ? 'cloudflare' : p === 'vercel' ? 'vercel' : null;
}

/**
 * Pick the provider for a store: per-store override → env default → 'vercel'.
 * `store` may be null (platform-level / no store context) → env default.
 */
export function resolveDomainService(
  store: { domainProvider?: string | null } | null | undefined
): DomainProvider {
  const perStore = normalize(store?.domainProvider);
  const chosen = perStore ?? normalize(config.domainProvider) ?? 'vercel';
  return PROVIDERS[chosen];
}

export function getDomainProviderName(
  store: { domainProvider?: string | null } | null | undefined
): 'vercel' | 'cloudflare' {
  return resolveDomainService(store).providerName;
}
