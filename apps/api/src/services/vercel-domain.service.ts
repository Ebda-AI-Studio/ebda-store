import { config } from '../config';

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
  private static isConfigured(): boolean {
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
      console.warn('[VERCEL] Vercel API not configured. Skipping domain addition for:', domain);
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
        console.error(
          '[VERCEL] Failed to add domain:',
          domain,
          'Status:',
          response.status,
          'Code:',
          data.error?.code
        );
        return null;
      }

      console.log('[VERCEL] Domain added successfully:', domain);
      return data;
    } catch (error) {
      console.error(
        '[VERCEL] Error adding domain:',
        domain,
        error instanceof Error ? error.message : 'Unknown error'
      );
      return null;
    }
  }

  /**
   * Remove a custom domain from the Vercel project
   */
  static async removeDomain(domain: string): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('[VERCEL] Vercel API not configured. Skipping domain removal for:', domain);
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
        console.error(
          '[VERCEL] Failed to remove domain:',
          domain,
          'Status:',
          response.status,
          'Code:',
          data.error?.code
        );
        return false;
      }

      console.log('[VERCEL] Domain removed successfully:', domain);
      return true;
    } catch (error) {
      console.error(
        '[VERCEL] Error removing domain:',
        domain,
        error instanceof Error ? error.message : 'Unknown error'
      );
      return false;
    }
  }

  /**
   * Get domain verification status from Vercel
   */
  static async getDomain(domain: string): Promise<DomainStatus | null> {
    if (!this.isConfigured()) {
      console.warn('[VERCEL] Vercel API not configured. Skipping domain check for:', domain);
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
        console.error('[VERCEL] Failed to get domain:', domain, 'Code:', data.error?.code);
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
      console.error(
        '[VERCEL] Error checking domain:',
        domain,
        error instanceof Error ? error.message : 'Unknown error'
      );
      return null;
    }
  }

  /**
   * List all domains on the Vercel project
   */
  static async listDomains(): Promise<VercelDomainResponse[]> {
    if (!this.isConfigured()) {
      console.warn('[VERCEL] Vercel API not configured. Skipping domain list.');
      return [];
    }

    try {
      const url = `${VERCEL_API_BASE}/v10/projects/${config.vercelProjectId}/domains${this.getTeamQuery()}`;
      const response = await fetch(url, { headers: this.getHeaders() });

      if (!response.ok) {
        console.error('[VERCEL] Failed to list domains. Status:', response.status);
        return [];
      }

      const data = (await response.json()) as VercelDomainsListResponse;
      return data.domains || [];
    } catch (error) {
      console.error(
        '[VERCEL] Error listing domains:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return [];
    }
  }

  /**
   * Verify a domain (trigger re-verification)
   */
  static async verifyDomain(domain: string): Promise<DomainStatus | null> {
    if (!this.isConfigured()) {
      console.warn('[VERCEL] Vercel API not configured. Skipping domain verify for:', domain);
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
        console.error('[VERCEL] Failed to verify domain:', domain, 'Code:', data.error?.code);
      }

      return this.getDomain(domain);
    } catch (error) {
      console.error(
        '[VERCEL] Error verifying domain:',
        domain,
        error instanceof Error ? error.message : 'Unknown error'
      );
      return null;
    }
  }
}
