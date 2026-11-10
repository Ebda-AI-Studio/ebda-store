import { config } from '../config';
import logger from '../lib/logger';
import type { DomainProvider, DomainStatus } from './domain-provider';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// Every CF Custom-Hostnames call is made in-request from the admin GET /domain
// handler. Without a timeout a slow/unreachable Cloudflare API stalls the whole
// request, and the admin domain page spins forever ("Check DNS" never settles).
// Fail fast: getDomain()/addHostname() already catch and degrade to the
// fallback CNAME, so a timeout surfaces as "provider unreachable", not a hang.
const CF_FETCH_TIMEOUT_MS = 8000;

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 4000;

async function dohAddresses(name: string): Promise<{ cname: string[]; addrs: string[] }> {
  const out = { cname: [] as string[], addrs: [] as string[] };
  for (const type of ['A', 'AAAA']) {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) continue;
    const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    for (const a of json.Answer ?? []) {
      if (a.type === 5) out.cname.push(a.data.replace(/\.$/, '').toLowerCase());
      else if (a.type === 1 || a.type === 28) out.addrs.push(a.data.toLowerCase());
    }
  }
  return out;
}

/**
 * Does `host` route to our Cloudflare-for-SaaS target? True for a visible CNAME to it, AND for a
 * FLATTENED apex (Cloudflare DNS, CNAME-flattening registrars): a flattened CNAME answers A/AAAA
 * records, never a CNAME, so a CNAME-only check calls a correct setup misconfigured. Addresses are
 * compared with what the target itself resolves to. Any lookup failure is "not proven" (false).
 */
export async function dnsPointsAtTarget(host: string, target: string): Promise<boolean> {
  try {
    const want = target.replace(/\.$/, '').toLowerCase();
    const [mine, ours] = await Promise.all([dohAddresses(host), dohAddresses(want)]);
    if (mine.cname.includes(want)) return true;
    return mine.addrs.length > 0 && mine.addrs.some(a => ours.addrs.includes(a));
  } catch {
    return false;
  }
}

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
 * Cloudflare-for-SaaS custom-domain provider (Custom Hostnames API). The sole
 * `DomainProvider` implementation (Vercel was cancelled 2026-07 and removed).
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

  /** Enroll ONE hostname as a Cloudflare-for-SaaS custom hostname. */
  private static async addHostname(hostname: string): Promise<CfCustomHostname | null> {
    try {
      const res = await fetch(this.base(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          hostname,
          ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
        }),
        signal: AbortSignal.timeout(CF_FETCH_TIMEOUT_MS),
      });
      const json = (await res.json()) as {
        success: boolean;
        result?: CfCustomHostname;
        errors?: unknown;
      };
      if (!res.ok || !json.success) {
        logger.error(
          { hostname, status: res.status, errors: json.errors },
          'CF custom hostname add failed'
        );
        return null;
      }
      logger.info({ hostname, id: json.result?.id }, 'CF custom hostname created');
      return json.result ?? null;
    } catch (error) {
      logger.error({ err: error, hostname }, 'CF custom hostname add threw');
      return null;
    }
  }

  static async addDomain(domain: string): Promise<CfCustomHostname | null> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Cloudflare-for-SaaS not configured, skipping custom hostname add');
      return null;
    }
    const apex = await this.addHostname(domain);
    // Also enroll the www subdomain so www.<domain> gets its own cert and routes
    // to the storefront worker (the web middleware then 301s www→apex). This is
    // what makes the admin's "www handled automatically" promise true. Best-effort:
    // a www failure must never block the apex the merchant actually saved, and we
    // skip it when the saved value is already a www host (stores save the apex).
    if (apex && !domain.startsWith('www.')) {
      const www = `www.${domain}`;
      const wwwResult = await this.addHostname(www);
      if (!wwwResult) {
        logger.warn({ domain, www }, 'CF www custom hostname enroll failed (apex succeeded)');
      }
    }
    return apex;
  }

  private static async findByHostname(domain: string): Promise<CfCustomHostname | null> {
    const res = await fetch(`${this.base()}?hostname=${encodeURIComponent(domain)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(CF_FETCH_TIMEOUT_MS),
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
      const sslActive = ch.ssl?.status === 'active';
      let verified = ch.status === 'active' && sslActive;
      // Cloudflare keeps the hostname `pending` (ownership not proven) when the apex is a flattened
      // CNAME, although the certificate is issued and traffic already routes to us. SSL issued +
      // DNS demonstrably pointing at our target is a verified claim.
      if (!verified && sslActive && ch.status === 'pending') {
        verified = await dnsPointsAtTarget(domain, config.cfFallbackOrigin);
      }
      // Terminal provider states: the hostname was blocked/moved/deleted, or
      // DCV / issuance timed out. Anything else (pending_validation, …) is "not yet".
      const failed =
        !verified &&
        (['blocked', 'moved', 'deleted'].includes(ch.status) ||
          /_timed_out$/.test(ch.ssl?.status ?? ''));
      return {
        domain,
        verified,
        failed,
        misconfigured: !verified,
        // Cloudflare-for-SaaS: one CNAME from the merchant's hostname to our zone target.
        dnsRecords: [{ type: 'CNAME', name: domain, value: config.cfFallbackOrigin }],
      };
    } catch (error) {
      logger.error({ err: error, domain }, 'CF custom hostname status threw');
      return null;
    }
  }

  /** Delete ONE custom hostname by name. Returns true if gone (or never existed). */
  private static async removeHostname(hostname: string): Promise<boolean> {
    const ch = await this.findByHostname(hostname);
    if (!ch) return true; // already gone
    const res = await fetch(`${this.base()}/${ch.id}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(CF_FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as { success: boolean };
    return res.ok && json.success;
  }

  static async removeDomain(domain: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const ok = await this.removeHostname(domain);
      // Best-effort: also remove the paired www hostname enrolled by addDomain,
      // so a domain removal doesn't leave an orphaned www custom hostname behind.
      if (!domain.startsWith('www.')) {
        await this.removeHostname(`www.${domain}`).catch(() => false);
      }
      return ok;
    } catch (error) {
      logger.error({ err: error, domain }, 'CF custom hostname delete threw');
      return false;
    }
  }
}

// Compile-time assertion that the class satisfies the provider contract.
const _assert: DomainProvider = CloudflareDomainService;
void _assert;
