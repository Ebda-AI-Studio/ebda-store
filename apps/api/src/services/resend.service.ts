import { Resend } from 'resend';
import { prisma } from '@force/database';
import { config } from '../config';

// Resend SDK wrapper — single platform-wide account. Merchant domains
// live under it as verified senders. See spec at
// docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md
//
// The class isolates two concerns from the rest of the codebase:
// (a) the actual SDK calls (so tests can mock one module), and
// (b) the persistence of Resend's domain id/status onto the Store row
// (so callers never need to know how we track Resend state).

export interface DomainDnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: string;
  priority?: number;
}

let _client: Resend | null = null;
function getClient(): Resend | null {
  if (!config.resendApiKey) return null;
  if (!_client) _client = new Resend(config.resendApiKey);
  return _client;
}

function ensureClient(): Resend {
  const c = getClient();
  if (!c) {
    throw new Error('RESEND_API_KEY not configured');
  }
  return c;
}

export class ResendService {
  static isConfigured(): boolean {
    return !!config.resendApiKey;
  }

  /**
   * Create (or refresh, if already created) a Resend domain for the store's
   * custom domain. Persists `emailDomainId` + `emailDomainStatus` and returns
   * the DNS records the merchant needs to add at their registrar.
   * Idempotent — safe to call repeatedly.
   */
  static async provisionStoreDomain(storeId: string): Promise<DomainDnsRecord[]> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, domain: true, emailDomainId: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    if (!store.domain) throw new Error('Store has no custom domain to provision');

    const client = ensureClient();

    if (store.emailDomainId) {
      // Already provisioned — fetch current state.
      const { data, error } = await client.domains.get(store.emailDomainId);
      if (error || !data) {
        throw new Error(`Resend get-domain failed: ${error?.message ?? 'unknown'}`);
      }
      await prisma.store.update({
        where: { id: storeId },
        data: { emailDomainStatus: (data as { status?: string }).status ?? 'pending' },
      });
      return ((data as { records?: unknown[] }).records ?? []).map(toDnsRecord);
    }

    const { data, error } = await client.domains.create({ name: store.domain });
    if (error || !data) {
      throw new Error(`Resend create-domain failed: ${error?.message ?? 'unknown'}`);
    }

    await prisma.store.update({
      where: { id: storeId },
      data: {
        emailDomainId: (data as { id: string }).id,
        emailDomainStatus: (data as { status?: string }).status ?? 'pending',
      },
    });

    return ((data as { records?: unknown[] }).records ?? []).map(toDnsRecord);
  }
}

function toDnsRecord(r: unknown): DomainDnsRecord {
  const rec = r as {
    type?: string;
    record?: string;
    name?: string;
    value?: string;
    ttl?: string;
    priority?: number;
  };
  // Resend's SDK uses `record` for the row type ("MX"/"TXT") historically and
  // sometimes `type` — normalise to one field so the admin renders cleanly.
  return {
    type: rec.type ?? rec.record ?? 'TXT',
    name: rec.name ?? '',
    value: rec.value ?? '',
    ttl: rec.ttl,
    priority: rec.priority,
  };
}
