import { config } from '../config';
import logger from '../lib/logger';
import type { DomainProvider, DomainStatus } from './domain-provider';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfCustomHostname {
  id: string;
  hostname: string;
  status: string; // 'active' | 'pending' | 'pending_deletion' | ...
  ssl?: {
    status?: string;
    validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    validation_errors?: Array<{ message: string }>;
  };
}

/**
 * Cloudflare-for-SaaS custom-domain provider (Custom Hostnames API).
 * Mirrors VercelDomainService's surface so resolveDomainService() can swap them.
 * Inactive (no-ops, logs) until CF_API_TOKEN / CF_ZONE_ID / CF_FALLBACK_ORIGIN are set.
 */
export class CloudflareDomainService {
  static readonly providerName = 'cloudflare' as const;

  static isConfigured(): boolean {
    return !!(config.cfApiToken && config.cfZoneId && config.cfFallbackOrigin);
  }

  private static headers(): Record<string, string> {
    return { Authorization: `Bearer ${config.cfApiToken}`, 'Content-Type': 'application/json' };
  }

  private static base(): string {
    return `${CF_API_BASE}/zones/${config.cfZoneId}/custom_hostnames`;
  }

  static async addDomain(domain: string): Promise<CfCustomHostname | null> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Cloudflare-for-SaaS not configured, skipping custom hostname add');
      return null;
    }
    try {
      const res = await fetch(this.base(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          hostname: domain,
          ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        result?: CfCustomHostname;
        errors?: unknown;
      };
      if (!res.ok || !json.success) {
        logger.error(
          { domain, status: res.status, errors: json.errors },
          'CF custom hostname add failed'
        );
        return null;
      }
      logger.info({ domain, id: json.result?.id }, 'CF custom hostname created');
      return json.result ?? null;
    } catch (error) {
      logger.error({ err: error, domain }, 'CF custom hostname add threw');
      return null;
    }
  }

  private static async findByHostname(domain: string): Promise<CfCustomHostname | null> {
    const res = await fetch(`${this.base()}?hostname=${encodeURIComponent(domain)}`, {
      headers: this.headers(),
    });
    const json = (await res.json()) as { success: boolean; result?: CfCustomHostname[] };
    if (!res.ok || !json.success || !json.result?.length) return null;
    return json.result[0];
  }

  static async getDomain(domain: string): Promise<DomainStatus | null> {
    if (!this.isConfigured()) return null;
    try {
      const ch = await this.findByHostname(domain);
      if (!ch) return null;
      const verified = ch.status === 'active' && ch.ssl?.status === 'active';
      return {
        domain,
        verified,
        misconfigured: !verified,
        // Cloudflare-for-SaaS: one CNAME from the merchant's hostname to our zone target.
        dnsRecords: [{ type: 'CNAME', name: domain, value: config.cfFallbackOrigin }],
      };
    } catch (error) {
      logger.error({ err: error, domain }, 'CF custom hostname status threw');
      return null;
    }
  }

  static async removeDomain(domain: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const ch = await this.findByHostname(domain);
      if (!ch) return true; // already gone
      const res = await fetch(`${this.base()}/${ch.id}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
      const json = (await res.json()) as { success: boolean };
      return res.ok && json.success;
    } catch (error) {
      logger.error({ err: error, domain }, 'CF custom hostname delete threw');
      return false;
    }
  }
}

// Compile-time assertion that the class satisfies the provider contract.
const _assert: DomainProvider = CloudflareDomainService;
void _assert;
