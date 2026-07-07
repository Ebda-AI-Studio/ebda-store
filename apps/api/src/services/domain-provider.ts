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

/**
 * The contract a custom-domain provider satisfies. Cloudflare-for-SaaS is the
 * only implementation (Vercel was cancelled 2026-07 and the VercelDomainService
 * branch removed here).
 */
export interface DomainProvider {
  readonly providerName: 'cloudflare';
  isConfigured(): boolean;
  /** Attach a custom domain. Returns true-ish on success, null when not configured. */
  addDomain(domain: string): Promise<unknown | null>;
  /** Detach a custom domain (rollback / removal). */
  removeDomain(domain: string): Promise<boolean>;
  /** Current verification + DNS instructions, or null when not configured / not found. */
  getDomain(domain: string): Promise<DomainStatus | null>;
}

/**
 * Cloudflare-for-SaaS is the sole custom-domain provider. `store` is still
 * accepted for signature compat with callers that pass per-store context
 * (`Store.domainProvider` is still read by them), but there is nothing left
 * to select between.
 */
export function resolveDomainService(
  _store?: { domainProvider?: string | null } | null
): DomainProvider {
  return CloudflareDomainService;
}

export function getDomainProviderName(
  store: { domainProvider?: string | null } | null | undefined
): 'cloudflare' {
  return resolveDomainService(store).providerName;
}
