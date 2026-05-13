import { config } from '../config';
import logger from '../lib/logger';

// ==========================================
// Vercel Domain Service
// Manages custom domains via Vercel REST API
// ==========================================

const VERCEL_API_BASE = 'https://api.vercel.com';

interface VercelDomainResponse {
  name: string;
  verified: boolean;
  verification?: Array<{
    type: string;
    domain: string;
    value: string;
    reason: string;
  }>;
  error?: { code: string; message: string };
}

interface VercelDomainConfig {
  configuredBy: string | null;
  misconfigured: boolean;
}

interface VercelDomainsListResponse {
  domains: VercelDomainResponse[];
}

export interface DomainStatus {
  domain: string;
  verified: boolean;
  misconfigured: boolean;
  dnsRecords: Array<{ type: string; name: string; value: string }>;
}

export class VercelDomainService {
  static isConfigured(): boolean {
    return !!(config.vercelApiToken && config.vercelProjectId);
  }

  private static getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${config.vercelApiToken}`,
      'Content-Type': 'application/json',
    };
  }

  private static getTeamQuery(): string {
    return config.vercelTeamId ? `?teamId=${config.vercelTeamId}` : '';
  }

  /**
   * Add a custom domain to the Vercel project. When the input is an
   * apex domain (no leading subdomain), ALSO attach the `www` variant
   * automatically — registrars like GoDaddy auto-create a locked
   * `CNAME www → @` that the merchant cannot delete or edit. If
   * Vercel doesn't know that hostname, visitors typing the www
   * variant get a generic Vercel 404 even though the DNS chain
   * technically reaches us. Pre-registering both spells out the
   * merchant flow: "one A record on apex, you're done."
   *
   * www-add failure is logged + ignored — the apex add is the only
   * outcome that matters for the calling endpoint's success.
   */
  static async addDomain(domain: string): Promise<VercelDomainResponse | null> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Vercel API not configured, skipping domain addition');
      return null;
    }

    const apexResult = await this.addDomainSingle(domain);
    if (!apexResult) return null;

    // Best-effort www variant. Skip if the input itself is a subdomain
    // (e.g. `shop.example.com`) — auto-adding `www.shop.example.com`
    // would be wrong. Two-dot test catches the apex form `example.com`.
    if (this.isApex(domain)) {
      const wwwDomain = `www.${domain}`;
      const wwwResult = await this.addDomainSingle(wwwDomain);
      if (wwwResult) {
        logger.info({ domain, wwwDomain }, 'www variant auto-attached to Vercel project');
      } else {
        logger.warn(
          { domain, wwwDomain },
          'www variant add failed (already on another project, or rejected). Apex still works.'
        );
      }
    }

    return apexResult;
  }

  /**
   * True if `domain` is an apex (e.g. `example.com`) and not already
   * a subdomain (`shop.example.com`, `www.example.com`). Heuristic:
   * exactly one dot in the host, OR a known 2-level TLD pattern
   * (`example.co.uk`). For our use-case the simple one-dot rule
   * covers >99% of merchants — GCC and TR ccTLDs are all 1-level
   * (`.kw`, `.sa`, `.ae`, `.com`).
   */
  private static isApex(domain: string): boolean {
    const parts = domain.toLowerCase().split('.').filter(Boolean);
    if (parts.length !== 2) return false;
    // Skip when input already begins with www to avoid recursing into www.www
    return parts[0] !== 'www';
  }

  /**
   * Low-level single-domain POST to Vercel's add-domain endpoint.
   * Public addDomain wraps this and may invoke twice (apex + www).
   */
  private static async addDomainSingle(domain: string): Promise<VercelDomainResponse | null> {
    try {
      const url = `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains${this.getTeamQuery()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ name: domain }),
      });

      const data = (await response.json()) as VercelDomainResponse;

      if (!response.ok) {
        // domain_already_in_use is a soft failure when re-attaching an
        // already-registered domain (e.g. www was added manually
        // earlier). Treat as success.
        if (data.error?.code === 'domain_already_in_use') {
          logger.info({ domain }, 'Domain already on Vercel project; treating as success');
          return data;
        }
        logger.error(
          { domain, status: response.status, code: data.error?.code },
          'Failed to add domain to Vercel'
        );
        return null;
      }

      logger.info({ domain }, 'Domain added successfully to Vercel');
      return data;
    } catch (error) {
      logger.error({ err: error, domain }, 'Error adding domain to Vercel');
      return null;
    }
  }

  /**
   * Remove a custom domain from the Vercel project
   */
  static async removeDomain(domain: string): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Vercel API not configured, skipping domain removal');
      return false;
    }

    try {
      const url = `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains/${domain}${this.getTeamQuery()}`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const data = (await response.json()) as VercelDomainResponse;
        logger.error(
          { domain, status: response.status, code: data.error?.code },
          'Failed to remove domain from Vercel'
        );
        return false;
      }

      logger.info({ domain }, 'Domain removed successfully from Vercel');
      return true;
    } catch (error) {
      logger.error({ err: error, domain }, 'Error removing domain from Vercel');
      return false;
    }
  }

  /**
   * Get domain verification status from Vercel
   */
  static async getDomain(domain: string): Promise<DomainStatus | null> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Vercel API not configured, skipping domain check');
      return null;
    }

    try {
      const teamQuery = this.getTeamQuery();
      const [domainRes, configRes] = await Promise.all([
        fetch(
          `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains/${domain}${teamQuery}`,
          { headers: this.getHeaders() }
        ),
        fetch(`${VERCEL_API_BASE}/v6/domains/${domain}/config${teamQuery}`, {
          headers: this.getHeaders(),
        }),
      ]);

      if (!domainRes.ok) {
        const data = (await domainRes.json()) as VercelDomainResponse;
        logger.error({ domain, code: data.error?.code }, 'Failed to get domain from Vercel');
        return null;
      }

      const domainData = (await domainRes.json()) as VercelDomainResponse;
      const configData: VercelDomainConfig = configRes.ok
        ? ((await configRes.json()) as VercelDomainConfig)
        : { configuredBy: null, misconfigured: true };

      const dnsRecords: DomainStatus['dnsRecords'] = [];

      if (!domainData.verified && domainData.verification?.length) {
        for (const v of domainData.verification) {
          dnsRecords.push({ type: v.type, name: v.domain, value: v.value });
        }
      }

      // Apex-only DNS instruction. The merchant needs to add ONE A
      // record at their registrar pointing apex `@` at Vercel's IP.
      // We intentionally do NOT instruct on a `www` CNAME because:
      //   (1) Most registrars (GoDaddy, etc.) auto-create a locked
      //       `www CNAME → @` the merchant can't edit or delete.
      //   (2) `addDomain` auto-attaches the www variant to the Vercel
      //       project, so the chain `www → apex → Vercel A` works
      //       and Vercel recognizes the www host header.
      // Older callers may receive a `dnsRecords` with the CNAME line
      // when a non-apex domain was attached (e.g. `shop.example.com`)
      // — we still emit the CNAME path in that case.
      const isApexDomain = domain.toLowerCase().split('.').filter(Boolean).length === 2;
      if (isApexDomain) {
        dnsRecords.push({ type: 'A', name: '@', value: '76.76.21.21' });
      } else {
        dnsRecords.push({ type: 'CNAME', name: domain, value: 'cname.vercel-dns.com' });
      }
      return {
        domain: domainData.name,
        verified: domainData.verified,
        misconfigured: configData.misconfigured,
        dnsRecords,
      };
    } catch (error) {
      logger.error({ err: error, domain }, 'Error checking domain on Vercel');
      return null;
    }
  }

  /**
   * List all domains on the Vercel project
   */
  static async listDomains(): Promise<VercelDomainResponse[]> {
    if (!this.isConfigured()) {
      logger.warn('Vercel API not configured, skipping domain list');
      return [];
    }

    try {
      const url = `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains${this.getTeamQuery()}`;
      const response = await fetch(url, { headers: this.getHeaders() });

      if (!response.ok) {
        logger.error({ status: response.status }, 'Failed to list domains from Vercel');
        return [];
      }

      const data = (await response.json()) as VercelDomainsListResponse;
      return data.domains || [];
    } catch (error) {
      logger.error({ err: error }, 'Error listing domains from Vercel');
      return [];
    }
  }

  /**
   * Verify a domain (trigger re-verification)
   */
  static async verifyDomain(domain: string): Promise<DomainStatus | null> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Vercel API not configured, skipping domain verify');
      return null;
    }

    try {
      const url = `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains/${domain}/verify${this.getTeamQuery()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const data = (await response.json()) as VercelDomainResponse;
        logger.error({ domain, code: data.error?.code }, 'Failed to verify domain on Vercel');
      }

      return this.getDomain(domain);
    } catch (error) {
      logger.error({ err: error, domain }, 'Error verifying domain on Vercel');
      return null;
    }
  }
}
