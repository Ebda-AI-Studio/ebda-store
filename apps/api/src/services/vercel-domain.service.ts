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
   * Add a custom domain to the Vercel project
   */
  static async addDomain(domain: string): Promise<VercelDomainResponse | null> {
    if (!this.isConfigured()) {
      logger.warn({ domain }, 'Vercel API not configured, skipping domain addition');
      return null;
    }

    try {
      const url = `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains${this.getTeamQuery()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ name: domain }),
      });

      const data = (await response.json()) as VercelDomainResponse;

      if (!response.ok) {
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

      // Always include the CNAME instruction
      dnsRecords.push({ type: 'CNAME', name: domain, value: 'cname.vercel-dns.com' });

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
